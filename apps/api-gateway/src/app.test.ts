import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGatewayApp } from './app.js';
import { configSchema } from './config.js';

let upstream: Server;
let upstreamUrl: string;
const seen: { headers: Record<string, unknown>; body: unknown; url: string }[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.all('/{*path}', async (req, res) => {
    seen.push({ headers: req.headers, body: req.body, url: req.originalUrl });
    if (req.path === '/api/v1/products/slow') await new Promise((resolve) => setTimeout(resolve, 500));
    if (req.path === '/api/v1/auth/login') res.cookie('emb_refresh_token', 'abc', { httpOnly: true });
    res.status(req.method === 'POST' ? 201 : 200).json({ ok: true, path: req.originalUrl });
  });
  upstream = await new Promise<Server>((resolve) => {
    const server = app.listen(0, () => {
      resolve(server);
    });
  });
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) =>
      upstream.close(() => {
        resolve();
      }),
    ),
);

function gateway(overrides: Record<string, string> = {}) {
  const urls = Object.fromEntries(
    ['AUTH', 'USER', 'PRODUCT', 'INVENTORY', 'ORDER', 'PAYMENT', 'NOTIFICATION', 'AUDIT'].map((name) => [
      `${name}_SERVICE_URL`,
      upstreamUrl,
    ]),
  );
  const config = configSchema.parse({
    REDIS_URL: 'redis://unused',
    UPSTREAM_TIMEOUT_MS: '200',
    HTTP_BODY_LIMIT: '1kb',
    AUTH_RATE_LIMIT_MAX: '2',
    ...urls,
    ...overrides,
  });
  return buildGatewayApp({ config, logger: pino({ level: 'silent' }) });
}

describe('api gateway', () => {
  it('forwards requests with correlation headers and strips forged internal tokens', async () => {
    const response = await request(gateway())
      .get('/api/v1/products?page=2')
      .set('X-Correlation-Id', 'corr-123')
      .set('X-Internal-Token', 'forged');
    expect(response.status).toBe(200);
    expect(response.body.path).toBe('/api/v1/products?page=2');
    const forwarded = seen.at(-1)!;
    expect(forwarded.headers['x-correlation-id']).toBe('corr-123');
    expect(forwarded.headers['x-request-id']).toBe(response.headers['x-request-id']);
    expect(forwarded.headers['x-internal-token']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('forwards JSON bodies and Set-Cookie headers', async () => {
    const response = await request(gateway())
      .post('/api/v1/auth/login')
      .send({ email: 'a@b.co', password: 'x' });
    expect(response.status).toBe(201);
    expect(seen.at(-1)!.body).toEqual({ email: 'a@b.co', password: 'x' });
    expect(response.headers['set-cookie']?.[0]).toContain('emb_refresh_token=abc');
  });

  it('enforces the request body limit before contacting the upstream', async () => {
    const before = seen.length;
    const response = await request(gateway())
      .post('/api/v1/orders')
      .send({ blob: 'x'.repeat(4_000) });
    expect(response.status).toBe(413);
    expect(seen.length).toBe(before);
  });

  it('does not expose internal, admin or operational upstream paths', async () => {
    for (const path of ['/internal/v1/products?ids=x', '/metrics', '/admin/v1/dead-letters']) {
      expect((await request(gateway()).get(path)).status, path).toBe(404);
    }
    expect((await request(gateway()).get('/api/v1/orders/%2e%2e/%2e%2e/internal/v1/products')).status).toBe(
      400,
    );
  });

  it('returns 504 problem details when an upstream is too slow', async () => {
    const response = await request(gateway()).get('/api/v1/products/slow');
    expect(response.status).toBe(504);
    expect(response.body.code).toBe('upstream_timeout');
  });

  it('returns 502 when an upstream is unreachable', async () => {
    const response = await request(gateway({ ORDER_SERVICE_URL: 'http://127.0.0.1:9' })).get(
      '/api/v1/orders',
    );
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('upstream_unreachable');
  });

  it('applies the strict limiter to credential endpoints', async () => {
    const app = gateway();
    const statuses = [];
    for (let i = 0; i < 3; i += 1)
      statuses.push((await request(app).post('/api/v1/auth/login').send({})).status);
    expect(statuses).toEqual([201, 201, 429]);
  });
});
