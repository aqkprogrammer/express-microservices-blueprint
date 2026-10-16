import type { Logger } from '@emb/logger';
import { serializeError } from '@emb/logger';
import { Redis } from 'ioredis';

/**
 * Redis client tuned for caching: short command timeout and no offline queue,
 * so a Redis outage makes cache calls fail fast instead of stalling requests.
 */
export function createCacheRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 250,
    connectTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  let lastLogged = 0;
  redis.on('error', (error) => {
    // Rate-limit error logs while Redis is down.
    if (Date.now() - lastLogged > 10_000) {
      lastLogged = Date.now();
      logger.warn({ err: serializeError(error) }, 'redis error (cache bypassed)');
    }
  });
  return redis;
}
