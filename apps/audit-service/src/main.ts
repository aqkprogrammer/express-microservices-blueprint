import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { MessageConsumer, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { buildAuditApp } from './app.js';
import { loadAuditConfig } from './config.js';
import { AuditService } from './domain/audit-service.js';
import { PrismaClient } from './generated/prisma/client.js';
import { registerAuditHandlers } from './messaging/handlers.js';
import { telemetry } from './telemetry.js';

const config = loadAuditConfig();
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

// The audit service only consumes; it publishes nothing, so it needs no outbox relay.
const rabbit = new RabbitMQClient({ url: config.RABBITMQ_URL, logger, connectionName: config.SERVICE_NAME });
runtime.onShutdown('rabbitmq', () => rabbit.close());
const service = new AuditService({ prisma, logger });
const consumer = new MessageConsumer({ client: rabbit, queue: CONSUMER_QUEUES.audit, logger, prefetch: 50 });
registerAuditHandlers(consumer, service, config.AUDIT_RETENTION_DAYS, prisma, logger);

const app = buildAuditApp({
  config,
  logger,
  service,
  verifier: createAccessTokenVerifier({ jwksUrl: config.JWKS_URL }),
  readinessChecks: [databaseHealthCheck(prisma), rabbit.healthCheck()],
  isShuttingDown: () => runtime.isShuttingDown,
});

await rabbit.connect();
consumer.start();
runtime.onShutdown('consumer', () => consumer.stop());
await runtime.listen(app, config.PORT);
