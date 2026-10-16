import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { MessageConsumer, OutboxRelay, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { buildInventoryApp } from './app.js';
import { loadInventoryConfig } from './config.js';
import { InventoryService } from './domain/inventory-service.js';
import { PrismaClient } from './generated/prisma/client.js';
import { registerInventoryHandlers } from './messaging/handlers.js';
import { telemetry } from './telemetry.js';

const config = loadInventoryConfig();
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
const service = new InventoryService({
  prisma,
  logger,
  reservationTtlMs: config.RESERVATION_TTL_MS,
  onEventsCommitted: () => {
    relay.notify();
  },
});
const consumer = new MessageConsumer({
  client: rabbit,
  queue: CONSUMER_QUEUES.inventory,
  logger,
  prefetch: config.CONSUMER_PREFETCH,
});
registerInventoryHandlers(consumer, service, prisma, logger);

const app = buildInventoryApp({
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
