import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { MessageConsumer, OutboxRelay, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { buildOrderApp } from './app.js';
import { PaymentClient } from './clients/payment-client.js';
import { ProductClient } from './clients/product-client.js';
import { loadOrderConfig } from './config.js';
import { OrderSaga, recordSagaOutcome } from './domain/order-saga.js';
import { OrderService } from './domain/order-service.js';
import { PrismaClient } from './generated/prisma/client.js';
import { registerOrderHandlers } from './messaging/handlers.js';
import { telemetry } from './telemetry.js';

const config = loadOrderConfig();
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
const upstream = { internalToken: config.INTERNAL_API_TOKEN, timeoutMs: config.UPSTREAM_TIMEOUT_MS, logger };

const service = new OrderService({
  prisma,
  products: new ProductClient({ ...upstream, baseUrl: config.PRODUCT_SERVICE_URL }),
  inventoryTimeoutMs: config.SAGA_INVENTORY_TIMEOUT_MS,
  maxLines: config.MAX_ORDER_LINES,
  onEventsCommitted: () => {
    relay.notify();
  },
  onSagaFinished: recordSagaOutcome,
});
const saga = new OrderSaga({
  prisma,
  payments: new PaymentClient({ ...upstream, baseUrl: config.PAYMENT_SERVICE_URL }),
  logger,
  paymentTimeoutMs: config.SAGA_PAYMENT_TIMEOUT_MS,
  maxPaymentAttempts: config.SAGA_MAX_PAYMENT_ATTEMPTS,
  onEventsCommitted: () => {
    relay.notify();
  },
});
const consumer = new MessageConsumer({
  client: rabbit,
  queue: CONSUMER_QUEUES.order,
  logger,
  prefetch: config.CONSUMER_PREFETCH,
});
registerOrderHandlers(consumer, saga, prisma, logger);

const app = buildOrderApp({
  config,
  logger,
  service,
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
