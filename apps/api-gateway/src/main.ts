import { ServiceRuntime } from '@emb/http-kit';
import { createLogger } from '@emb/logger';
import { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { buildGatewayApp, buildMetricsApp } from './app.js';
import { loadGatewayConfig } from './config.js';
import { telemetry } from './telemetry.js';

const config = loadGatewayConfig();
const logger = createLogger({
  service: config.SERVICE_NAME,
  environment: config.NODE_ENV,
  level: config.LOG_LEVEL,
});
const runtime = new ServiceRuntime({ logger, shutdownTimeoutMs: config.SHUTDOWN_TIMEOUT_MS });
runtime.installSignalHandlers();
runtime.onShutdown('telemetry', () => telemetry.shutdown());

// Rate-limit counters live in Redis so limits hold across gateway replicas.
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  commandTimeout: 250,
  connectTimeout: 2_000,
});
redis.on('error', () => undefined);
runtime.onShutdown('redis', async () => {
  await redis.quit().catch(() => {
    redis.disconnect();
  });
});
const store = (prefix: string) =>
  new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
  });

const app = buildGatewayApp({
  config,
  logger,
  rateLimitStores: { global: store('rl:global:'), strict: store('rl:auth:') },
  readinessChecks: [
    {
      name: 'redis',
      critical: false,
      check: async () => {
        await redis.ping();
      },
    },
  ],
  isShuttingDown: () => runtime.isShuttingDown,
});
await runtime.listen(app, config.PORT);
if (config.METRICS_ENABLED) {
  const metricsServer = buildMetricsApp().listen(config.METRICS_PORT, () => {
    logger.info({ port: config.METRICS_PORT }, 'metrics listener started');
  });
  runtime.onShutdown(
    'metrics-listener',
    () =>
      new Promise((resolve) =>
        metricsServer.close(() => {
          resolve();
        }),
      ),
  );
}
