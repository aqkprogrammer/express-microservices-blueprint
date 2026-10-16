import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime, createServiceApp } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { MessageConsumer, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { Redis } from 'ioredis';
import { loadWorkerConfig } from './config.js';
import { DeadLetterArchive } from './dead-letters/archive.js';
import { PrismaClient } from './generated/prisma/client.js';
import { adminRoutes } from './http/routes.js';
import { MaintenanceScheduler } from './scheduler/scheduler.js';
import { telemetry } from './telemetry.js';

const config = loadWorkerConfig();
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

const redis = new Redis(config.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 500,
});
redis.on('error', () => undefined);
runtime.onShutdown('redis', async () => {
  await redis.quit().catch(() => {
    redis.disconnect();
  });
});

const rabbit = new RabbitMQClient({ url: config.RABBITMQ_URL, logger, connectionName: config.SERVICE_NAME });
runtime.onShutdown('rabbitmq', () => rabbit.close());

const archive = new DeadLetterArchive({ prisma, rabbit, logger });
const consumer = new MessageConsumer({
  client: rabbit,
  queue: CONSUMER_QUEUES.deadLetters,
  logger,
  prefetch: config.WORKER_CONCURRENCY,
  // Never drop or re-dead-letter a dead letter: if archiving keeps failing, keep it on the queue.
  onRetriesExhausted: 'requeue',
}).onRaw((message) => archive.archive(message));

const scheduler = new MaintenanceScheduler({
  rabbit,
  redis,
  logger,
  recorder: {
    record: async (task, outcome, durationMs, error) => {
      await prisma.jobRun.create({ data: { task, outcome, durationMs, error: error ?? null } });
    },
  },
});

const app = createServiceApp({
  serviceName: config.SERVICE_NAME,
  logger,
  trustProxy: config.TRUST_PROXY,
  metricsEnabled: config.METRICS_ENABLED,
  readinessChecks: [
    databaseHealthCheck(prisma),
    rabbit.healthCheck(),
    {
      name: 'redis',
      critical: false,
      check: async () => {
        await redis.ping();
      },
    },
  ],
  isShuttingDown: () => runtime.isShuttingDown,
  routes: (express) =>
    express.use(adminRoutes({ archive, verifier: createAccessTokenVerifier({ jwksUrl: config.JWKS_URL }) })),
});

// Job history retention runs alongside the scheduler (cheap, local to the worker's own DB).
const retention = setInterval(() => {
  void prisma.jobRun
    .deleteMany({
      where: { startedAt: { lt: new Date(Date.now() - config.JOB_RUN_RETENTION_DAYS * 86_400_000) } },
    })
    .catch(() => undefined);
}, 3_600_000);
runtime.onShutdown('retention', () => {
  clearInterval(retention);
  return Promise.resolve();
});

await rabbit.connect();
consumer.start();
if (config.SCHEDULER_ENABLED) scheduler.start();
runtime.onShutdown('scheduler', () => scheduler.stop());
runtime.onShutdown('consumer', () => consumer.stop());
await runtime.listen(app, config.PORT);
