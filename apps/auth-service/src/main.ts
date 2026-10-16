import { CONSUMER_QUEUES } from '@emb/contracts';
import { createPgPool, createPrismaAdapter, databaseHealthCheck } from '@emb/database';
import { ServiceRuntime } from '@emb/http-kit';
import { createLogger, serializeError } from '@emb/logger';
import { MessageConsumer, OutboxRelay, RabbitMQClient } from '@emb/messaging';
import { createAccessTokenVerifier } from '@emb/security';
import { buildAuthApp } from './app.js';
import { loadAuthConfig } from './config.js';
import { AuthService } from './domain/auth-service.js';
import { loadSigningMaterial } from './domain/tokens.js';
import { PrismaClient } from './generated/prisma/client.js';
import { registerAuthHandlers } from './messaging/handlers.js';
import { telemetry } from './telemetry.js';

const config = loadAuthConfig();
const logger = createLogger({
  service: config.SERVICE_NAME,
  environment: config.NODE_ENV,
  level: config.LOG_LEVEL,
});
const runtime = new ServiceRuntime({ logger, shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS });
runtime.installSignalHandlers();
runtime.onShutdown('telemetry', () => telemetry.shutdown());

const signing = await loadSigningMaterial(config.JWT_PRIVATE_KEY, config.JWT_PREVIOUS_PUBLIC_KEY);
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
const service = new AuthService({
  prisma,
  signing,
  logger,
  accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
  passwordResetTtlSeconds: config.PASSWORD_RESET_TTL_SECONDS,
  passwordResetUrl: config.PASSWORD_RESET_URL,
  maxFailedLogins: config.MAX_FAILED_LOGINS,
  lockoutSeconds: config.LOCKOUT_SECONDS,
  onEventsCommitted: () => {
    relay.notify();
  },
});
const consumer = new MessageConsumer({ client: rabbit, queue: CONSUMER_QUEUES.auth, logger });
registerAuthHandlers(consumer, service, prisma, logger);

const app = buildAuthApp({
  config,
  logger,
  service,
  signing,
  // auth-service verifies its own tokens from the in-memory key set (no network hop).
  verifier: createAccessTokenVerifier({ jwks: signing.jwks }),
  readinessChecks: [databaseHealthCheck(prisma), rabbit.healthCheck()],
  isShuttingDown: () => runtime.isShuttingDown,
});

await rabbit.connect();
consumer.start();
relay.start();
runtime.onShutdown('outbox-relay', () => relay.stop());
runtime.onShutdown('consumer', () => consumer.stop());
await runtime.listen(app, config.PORT);

if (config.ADMIN_EMAIL && config.ADMIN_BOOTSTRAP_PASSWORD) {
  service
    .ensureAdmin(config.ADMIN_EMAIL, config.ADMIN_BOOTSTRAP_PASSWORD)
    .then((created) => {
      if (created) logger.warn({ email: config.ADMIN_EMAIL }, 'bootstrap admin created; change its password');
    })
    .catch((error: unknown) => {
      logger.error({ err: serializeError(error) }, 'bootstrap admin creation failed');
    });
}
