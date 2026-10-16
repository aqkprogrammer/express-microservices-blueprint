import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { MessageConsumer, OutboxRelay, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { buildPaymentApp } from './app.js';
import { loadPaymentConfig } from './config.js';
import { IdempotencyStore } from './domain/idempotency.js';
import { PaymentService } from './domain/payment-service.js';
import { PrismaClient } from './generated/prisma/client.js';
import { registerPaymentHandlers } from './messaging/handlers.js';
import { PaymentProviderSimulator } from './simulator/provider-simulator.js';
import { telemetry } from './telemetry.js';

const config = loadPaymentConfig();
const logger = createLogger({
  service: config.SERVICE_NAME,
  environment: config.NODE_ENV,
  level: config.LOG_LEVEL,
});
const runtime = new ServiceRuntime({ logger, shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS });
runtime.installSignalHandlers();
runtime.onShutdown('telemetry', () => telemetry.shutdown());

const pool = createPgPool({
  connectionString: config.DATABASE_URL,
  name: config.SERVICE_NAME,
  max: config.DATABASE_POOL_SIZE,
});
const prisma = new PrismaClient({ adapter: createPrismaAdapter(pool) });
runtime.onShutdown('postgres', async () => {
  await prisma.$disconnect();
  await pool.end();
});

const rabbit = new RabbitMQClient({ url: config.RABBITMQ_URL, logger, connectionName: config.SERVICE_NAME });
runtime.onShutdown('rabbitmq', () => rabbit.close());
const relay = new OutboxRelay({ db: prisma, client: rabbit, logger });
const service = new PaymentService({
  prisma,
  provider: new PaymentProviderSimulator({
    latencyMs: config.SIMULATOR_LATENCY_MS,
    timeoutResolvesAfterMs: config.SIMULATOR_TIMEOUT_RESOLVES_AFTER_MS,
  }),
  logger,
  reconcileAfterMs: config.RECONCILE_AFTER_MS,
  onEventsCommitted: () => {
    relay.notify();
  },
});
const idempotency = new IdempotencyStore(prisma);
const consumer = new MessageConsumer({
  client: rabbit,
  queue: CONSUMER_QUEUES.payment,
  logger,
  prefetch: config.CONSUMER_PREFETCH,
});
registerPaymentHandlers(consumer, service, idempotency, prisma, logger);

const app = buildPaymentApp({
  config,
  logger,
  service,
  idempotency,
  verifier: createAccessTokenVerifier({ jwksUrl: config.JWKS_URL }),
  readinessChecks: [databaseHealthCheck(prisma), rabbit.healthCheck()],
  isShuttingDown: () => runtime.isShuttingDown,
});

await rabbit.connect();
consumer.start();
relay.start();
runtime.onShutdown('outbox-relay', () => relay.stop());
runtime.onShutdown('consumer', () => consumer.stop());
await runtime.listen(app, config.PORT);
