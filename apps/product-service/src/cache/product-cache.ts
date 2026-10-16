import { createHash } from 'node:crypto';
import type { Logger } from '@emb/logger';
import { counter } from '@emb/observability';
import type { Redis } from 'ioredis';

const cacheRequests = counter('cache_requests_total', 'Cache lookups by result', ['cache', 'result']);

const PREFIX = 'product:v1';
const LIST_GENERATION_KEY = `${PREFIX}:list-generation`;

export interface CacheTtls {
  detailSeconds: number;
  listSeconds: number;
}

/**
 * Cache-aside for product reads.
 *  - Detail entries are deleted on change; list pages are invalidated in bulk by
 *    bumping a generation counter that is part of every list key.
 *  - Stampede protection: concurrent misses in one process share a single load
 *    (single-flight), and a short Redis lock lets one instance refill a hot key
 *    while others briefly wait. TTLs get ±10% jitter so keys do not expire together.
 *  - Redis is never the source of truth: any Redis error falls through to Postgres.
 */
export class ProductCache {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly redis: Redis | undefined,
    private readonly logger: Logger,
    private readonly ttls: CacheTtls,
  ) {}

  detailKey(productId: string): string {
    return `${PREFIX}:detail:${productId}`;
  }

  async listKey(query: Record<string, unknown>): Promise<string> {
    const generation = (await this.safe(() => this.redis?.get(LIST_GENERATION_KEY))) ?? '0';
    const normalized = JSON.stringify(
      Object.keys(query)
        .sort()
        .map((key) => [key, query[key]]),
    );
    return `${PREFIX}:list:${generation}:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
  }

  async getOrLoad<T>(cache: 'detail' | 'list', key: string, loader: () => Promise<T>): Promise<T> {
    const cached = await this.safe(() => this.redis?.get(key));
    if (cached) {
      cacheRequests.inc({ cache, result: 'hit' });
      return JSON.parse(cached) as T;
    }
    cacheRequests.inc({ cache, result: cached === undefined && !this.isAvailable() ? 'bypass' : 'miss' });

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const load = this.loadAndFill(key, cache, loader).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, load);
    return load;
  }

  private async loadAndFill<T>(key: string, cache: 'detail' | 'list', loader: () => Promise<T>): Promise<T> {
    const lockKey = `${key}:lock`;
    const gotLock = await this.safe(() => this.redis?.set(lockKey, '1', 'PX', 2_000, 'NX'));
    if (gotLock !== 'OK' && this.isAvailable()) {
      // Another instance is refilling this key; give it a moment before loading ourselves.
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const filled = await this.safe(() => this.redis?.get(key));
        if (filled) return JSON.parse(filled) as T;
      }
    }
    const value = await loader();
    if (value !== null && value !== undefined) {
      const base = cache === 'detail' ? this.ttls.detailSeconds : this.ttls.listSeconds;
      const ttl = Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
      await this.safe(() => this.redis?.set(key, JSON.stringify(value), 'EX', ttl));
    }
    if (gotLock === 'OK') await this.safe(() => this.redis?.del(lockKey));
    return value;
  }

  /** Called after a product change commits. */
  async invalidateProduct(productId: string): Promise<void> {
    await this.safe(() => this.redis?.del(this.detailKey(productId)));
    await this.safe(() => this.redis?.incr(LIST_GENERATION_KEY));
  }

  isAvailable(): boolean {
    return this.redis?.status === 'ready';
  }

  healthCheck() {
    return {
      name: 'redis',
      // The cache is an optimisation: when it is down the service still answers from Postgres.
      critical: false,
      check: async () => {
        await this.redis?.ping();
      },
    };
  }

  private async safe<T>(operation: () => Promise<T> | undefined): Promise<T | undefined> {
    if (!this.redis || !this.isAvailable()) return undefined;
    try {
      return await operation();
    } catch (error) {
      cacheRequests.inc({ cache: 'redis', result: 'error' });
      this.logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        'cache operation failed',
      );
      return undefined;
    }
  }
}
