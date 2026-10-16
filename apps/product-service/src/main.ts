import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { MessageConsumer, OutboxRelay, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { buildProductApp } from './app.js';
import { ProductCache } from './cache/product-cache.js';
import { createCacheRedis } from './cache/redis.js';
import { loadProductConfig } from './config.js';
import { ProductService } from './domain/product-service.js';
import { PrismaClient } from './generated/prisma/client.js';
import { registerProductHandlers } from './messaging/handlers.js';
import { telemetry } from './telemetry.js';

const config = loadProductConfig();
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

const redis = createCacheRedis(config.REDIS_URL, logger);
runtime.onShutdown('redis', async () => {
  await redis.quit().catch(() => {
    redis.disconnect();
  });
});
const cache = new ProductCache(redis, logger, {
  detailSeconds: config.CACHE_DETAIL_TTL_SECONDS,
  listSeconds: config.CACHE_LIST_TTL_SECONDS,
});

const rabbit = new RabbitMQClient({ url: config.RABBITMQ_URL, logger, connectionName: config.SERVICE_NAME });
runtime.onShutdown('rabbitmq', () => rabbit.close());
const relay = new OutboxRelay({ db: prisma, client: rabbit, logger });
const service = new ProductService({
  prisma,
  cache,
  onEventsCommitted: () => {
    relay.notify();
  },
});
const consumer = new MessageConsumer({
  client: rabbit,
  queue: CONSUMER_QUEUES.product,
  logger,
  prefetch: 20,
});
registerProductHandlers(consumer, service, prisma, logger);

const app = buildProductApp({
  config,
  logger,
  service,
  verifier: createAccessTokenVerifier({ jwksUrl: config.JWKS_URL }),
  readinessChecks: [databaseHealthCheck(prisma), rabbit.healthCheck(), cache.healthCheck()],
  isShuttingDown: () => runtime.isShuttingDown,
});

await rabbit.connect();
consumer.start();
relay.start();
runtime.onShutdown('outbox-relay', () => relay.stop());
runtime.onShutdown('consumer', () => consumer.stop());
await runtime.listen(app, config.PORT);
