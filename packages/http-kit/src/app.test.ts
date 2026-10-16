import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServiceApp } from './app.js';
import { ConflictError } from './errors.js';
import { parseWith } from './validation.js';

const logger = pino({ level: 'silent' });

function buildApp(ready = true) {
  return createServiceApp({
    serviceName: 'test-service',
    logger,
    bodyLimit: '1kb',
    corsAllowedOrigins: ['http://localhost:5173'],
    readinessChecks: [
      { name: 'database', check: async () => (ready ? undefined : Promise.reject(new Error('db down'))) },
      { name: 'cache', critical: false, check: async () => Promise.reject(new Error('redis down')) },
    ],
    routes: (app) => {
      app.post('/things', (req, res) => {
        const body = parseWith(z.object({ name: z.string().min(2) }), req.body);
        res.status(201).json(body);
      });
      app.get('/conflict', () => {
        throw new ConflictError('already exists');
      });
      app.get('/boom', () => {
        throw new Error('database password is hunter2');
      });
    },
  });
}

describe('createServiceApp', () => {
  it('sets security headers and request IDs', async () => {
    const response = await request(buildApp()).get('/health/live').set('X-Request-Id', 'abc-123');
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('abc-123');
    expect(response.headers['x-correlation-id']).toBe('abc-123');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('replaces unsafe caller-supplied request IDs', async () => {
    const response = await request(buildApp()).get('/health/live').set('X-Request-Id', 'bad id with spaces');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns RFC 9457 problems for validation errors', async () => {
    const response = await request(buildApp()).post('/things').send({ name: 'x' });
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 400, code: 'validation_failed' });
    expect(response.body.errors[0].path).toBe('body.name');
  });

  it('maps domain errors and hides internal error details', async () => {
    expect((await request(buildApp()).get('/conflict')).body).toMatchObject({
      status: 409,
      detail: 'already exists',
    });
    const boom = await request(buildApp()).get('/boom');
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toContain('hunter2');
  });

  it('enforces the body size limit and rejects malformed JSON', async () => {
    const big = await request(buildApp())
      .post('/things')
      .send({ name: 'x'.repeat(5_000) });
    expect(big.status).toBe(413);
    const malformed = await request(buildApp())
      .post('/things')
      .set('content-type', 'application/json')
      .send('{"name":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('malformed_json');
  });

  it('reports readiness with critical and non-critical checks', async () => {
    const healthy = await request(buildApp(true)).get('/health/ready');
    expect(healthy.status).toBe(200);
    expect(healthy.body.status).toBe('degraded');
    const unhealthy = await request(buildApp(false)).get('/health/ready');
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.body.checks.database.status).toBe('failed');
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const allowed = await request(buildApp()).options('/things').set('Origin', 'http://localhost:5173');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(buildApp()).options('/things').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes Prometheus metrics with route templates', async () => {
    const app = buildApp();
    await request(app).post('/things').send({ name: 'valid' });
    const metrics = await request(app).get('/metrics');
    expect(metrics.text).toContain('http_requests_total');
    expect(metrics.text).toContain('route="/things"');
  });
});
