import { createLogger } from '@emb/logger';
import { startPostgres, startRedis, waitFor, type StartedDependency } from '@emb/testing';
import { type Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestKeys, type TestKeys } from '@emb/testing';
import { createAccessTokenVerifier } from '@emb/security';
import { buildProductApp } from '../../apps/product-service/src/app.js';
import { ProductCache } from '../../apps/product-service/src/cache/product-cache.js';
import { createCacheRedis } from '../../apps/product-service/src/cache/redis.js';
import { ProductService } from '../../apps/product-service/src/domain/product-service.js';
import { PrismaClient } from '../../apps/product-service/src/generated/prisma/client.js';
import { createServiceDatabase, prismaFor, silentLogger } from './helpers.js';

let postgres: StartedDependency;
let redisContainer: StartedDependency;
let db: ReturnType<typeof prismaFor<PrismaClient>>;
let redis: Redis;
let keys: TestKeys;
let app: ReturnType<typeof buildProductApp>;
let adminToken: string;
let customerToken: string;
const INTERNAL = 'integration-internal-token-0123456789abcdef';

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([startPostgres(), startRedis()]);
  db = prismaFor(PrismaClient, await createServiceDatabase(postgres, 'product-service'), 'product-it');
  redis = createCacheRedis(redisContainer.url, silentLogger);
  await waitFor(async () => redis.status === 'ready' || undefined);
  keys = await createTestKeys();
  adminToken = await keys.sign({ userId: '00000000-0000-4000-8000-0000000000aa', roles: ['admin'] });
  customerToken = await keys.sign({ userId: '00000000-0000-4000-8000-0000000000cc' });
  const service = new ProductService({
    prisma: db.client,
    cache: new ProductCache(redis, silentLogger, { detailSeconds: 60, listSeconds: 60 }),
    onEventsCommitted: () => undefined,
  });
  app = buildProductApp({
    config: {
      SERVICE_NAME: 'product-service',
      HTTP_BODY_LIMIT: '100kb',
      TRUST_PROXY: 'loopback',
      CORS_ALLOWED_ORIGINS: [],
      METRICS_ENABLED: true,
      DOCS_ENABLED: false,
      INTERNAL_API_TOKEN: INTERNAL,
    },
    logger: createLogger({ service: 'product-it', level: 'silent' }),
    service,
    verifier: createAccessTokenVerifier({ jwks: keys.jwks }),
    readinessChecks: [],
  });
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await db?.client.$disconnect();
  await db?.close();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
});

const create = (sku: string, priceCents: number, token = adminToken) =>
  request(app)
    .post('/api/v1/products')
    .set('authorization', `Bearer ${token}`)
    .send({ sku, name: `Product ${sku}`, category: 'test', priceCents, status: 'active' });

describe('product service HTTP + cache (real Postgres + Redis)', () => {
  it('enforces admin-only writes and validates input', async () => {
    expect((await create('SKU-AUTH-1', 100, customerToken)).status).toBe(403);
    expect((await request(app).post('/api/v1/products').send({})).status).toBe(401);
    const invalid = await create('lowercase-sku', -5);
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(['body.sku', 'body.priceCents']),
    );
    expect((await create('SKU-DUP-1', 100)).status).toBe(201);
    expect((await create('SKU-DUP-1', 100)).body.code).toBe('duplicate_sku');
  });

  it('serves lists from Redis and invalidates them when a product changes', async () => {
    const created = await create('SKU-CACHE-1', 1_000);
    const id = created.body.id as string;
    const first = await request(app).get('/api/v1/products?q=SKU-CACHE-1');
    expect(first.body.data[0].price.amountCents).toBe(1_000);
    expect(await redis.keys('product:v1:list:*')).not.toHaveLength(0);

    // A stale cache would keep returning 1000 for the next 60s.
    const updated = await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ priceCents: 900, expectedVersion: 1 });
    expect(updated.status).toBe(200);
    const after = await request(app).get('/api/v1/products?q=SKU-CACHE-1');
    expect(after.body.data[0].price.amountCents).toBe(900);

    const conflict = await request(app)
      .patch(`/api/v1/products/${id}`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ priceCents: 800, expectedVersion: 1 });
    expect(conflict.body.code).toBe('version_conflict');
  });

  it('paginates with a stable order and reports totals', async () => {
    for (let i = 0; i < 5; i += 1) await create(`SKU-PAGE-${i}`, 100 + i);
    const page = await request(app).get('/api/v1/products?category=test&pageSize=2&page=2&sort=price');
    expect(page.body.pagination).toMatchObject({ page: 2, pageSize: 2 });
    expect(page.body.data).toHaveLength(2);
    expect(page.body.data[0].price.amountCents).toBeLessThanOrEqual(page.body.data[1].price.amountCents);
  });

  it('keeps serving from Postgres when Redis is unavailable (fail-open cache)', async () => {
    await redisContainer.pause();
    try {
      const started = Date.now();
      const response = await request(app).get('/api/v1/products?pageSize=5');
      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(3_000);
      const ready = await request(app).get('/api/v1/products/does-not-matter');
      expect(ready.status).toBe(400);
    } finally {
      await redisContainer.unpause();
    }
  });

  it('exposes price snapshots only on the internal API with the service token', async () => {
    const created = await create('SKU-INT-1', 4_200);
    const path = `/internal/v1/products?ids=${created.body.id as string}`;
    expect((await request(app).get(path)).status).toBe(401);
    const response = await request(app).get(path).set('x-internal-token', INTERNAL);
    expect(response.body.data[0]).toMatchObject({ sku: 'SKU-INT-1', priceCents: 4_200 });
  });
});
