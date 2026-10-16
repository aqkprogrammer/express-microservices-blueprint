import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { BASE_URL, api, loginAdmin } from '../support/api.js';

describe('API gateway (end to end)', () => {
  it('is healthy and adds request IDs and security headers', async () => {
    const response = await api('GET', '/health/ready', { headers: { 'X-Request-Id': 'e2e-request-1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('e2e-request-1');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('strict-transport-security')).toBeTruthy();
  });

  it('does not expose internal, operational or administrative endpoints', async () => {
    for (const path of [
      '/internal/v1/products?ids=x',
      '/metrics',
      '/admin/v1/dead-letters',
      '/openapi.json',
    ]) {
      expect((await api('GET', path)).status, path).toBe(404);
    }
    // fetch() would normalise the dot segments client-side, so send the raw path.
    const raw = await new Promise<number>((resolve, reject) => {
      const url = new URL(BASE_URL);
      request(
        { host: url.hostname, port: url.port, path: '/api/v1/orders/%2e%2e/%2e%2e/internal/v1/products' },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(raw).toBe(400);
  });

  it('returns RFC 9457 problem details', async () => {
    const response = await fetch(`${BASE_URL}/api/v1/nope`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.json()).toMatchObject({ status: 404, code: 'not_found', title: 'Not Found' });
  });

  it('rejects oversized request bodies at the edge', async () => {
    const response = await api('POST', '/api/v1/auth/login', {
      body: { email: 'x@example.com', password: 'p'.repeat(300_000) },
    });
    expect(response.status).toBe(413);
  });

  it('serves aggregated Swagger UI and every service specification', async () => {
    const ui = await fetch(`${BASE_URL}/docs/`);
    expect(ui.status).toBe(200);
    for (const service of [
      'auth',
      'user',
      'product',
      'inventory',
      'order',
      'payment',
      'notification',
      'audit',
    ]) {
      const spec = await api('GET', `/docs/specs/${service}.json`);
      expect(spec.body.openapi, service).toBe('3.1.0');
    }
  });

  it('serves the public catalog anonymously and hides drafts', async () => {
    const admin = await loginAdmin();
    const list = await api('GET', '/api/v1/products?pageSize=100');
    expect(list.status).toBe(200);
    expect(list.body.data.every((product: { status: string }) => product.status === 'active')).toBe(true);
    const adminDrafts = await api('GET', '/api/v1/products?status=draft&pageSize=5', { token: admin });
    expect(adminDrafts.status).toBe(200);
  });

  it('publishes the JWKS used by every service to verify tokens', async () => {
    const jwks = await api('GET', '/.well-known/jwks.json');
    expect(jwks.body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.body.keys[0].d).toBeUndefined();
  });
});
