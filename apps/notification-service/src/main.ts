import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { MessageConsumer, OutboxRelay, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { buildNotificationApp } from './app.js';
import { loadNotificationConfig } from './config.js';
import { NotificationService } from './domain/notification-service.js';
import { PrismaClient } from './generated/prisma/client.js';
import { registerNotificationHandlers } from './messaging/handlers.js';
import { telemetry } from './telemetry.js';
import {
  ConsoleTransport,
  FailureSimulatingTransport,
  SmtpTransport,
  type EmailTransport,
} from './transport/email-transport.js';

const config = loadNotificationConfig();
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

let transport: EmailTransport =
  config.EMAIL_TRANSPORT === 'smtp'
    ? new SmtpTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        user: config.SMTP_USER,
        password: config.SMTP_PASSWORD,
        from: config.EMAIL_FROM,
      })
    : new ConsoleTransport(logger);
if (config.SIMULATE_FAILURE_DOMAIN) {
  if (config.NODE_ENV === 'production')
    throw new Error('SIMULATE_FAILURE_DOMAIN must not be set in production');
  transport = new FailureSimulatingTransport(transport, config.SIMULATE_FAILURE_DOMAIN);
}

const rabbit = new RabbitMQClient({ url: config.RABBITMQ_URL, logger, connectionName: config.SERVICE_NAME });
runtime.onShutdown('rabbitmq', () => rabbit.close());
const relay = new OutboxRelay({ db: prisma, client: rabbit, logger });
const service = new NotificationService({
  prisma,
  transport,
  logger,
  onEventsCommitted: () => {
    relay.notify();
  },
});
const queue = CONSUMER_QUEUES.notification;
const consumer = new MessageConsumer({ client: rabbit, queue, logger, prefetch: config.CONSUMER_PREFETCH });
registerNotificationHandlers(consumer, service, queue.retryDelaysMs.length, prisma, logger);

const app = buildNotificationApp({
  config,
  logger,
  service,
  verifier: createAccessTokenVerifier({ jwksUrl: config.JWKS_URL }),
  readinessChecks: [databaseHealthCheck(prisma), rabbit.healthCheck()],
  isShuttingDown: () => runtime.isShuttingDown,
});

await service.ensureDefaultTemplates();
await rabbit.connect();
consumer.start();
relay.start();
runtime.onShutdown('outbox-relay', () => relay.stop());
runtime.onShutdown('consumer', () => consumer.stop());
await runtime.listen(app, config.PORT);
logger.info({ transport: transport.name }, 'email transport configured');
