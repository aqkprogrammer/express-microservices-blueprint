import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ServiceUnavailableError, UpstreamError } from './errors.js';
import { ServiceClient } from './http-client.js';

const logger = pino({ level: 'silent' });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof ServiceClient>[0]> = {},
) {
  return new ServiceClient({
    target: 'product-service',
    baseUrl: 'http://product-service:3003',
    logger,
    fetchImpl,
    maxRetries: 2,
    ...extra,
  });
}

describe('ServiceClient', () => {
  it('validates responses with the given schema and sends correlation headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { id: 'p1', price: 10 }));
    const result = await client(fetchImpl).request({
      path: '/internal/v1/products',
      query: { ids: 'p1' },
      schema: z.object({ id: z.string(), price: z.number() }),
    });
    expect(result).toEqual({ id: 'p1', price: 10 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect((url as URL).href).toBe('http://product-service:3003/internal/v1/products?ids=p1');
    expect((init?.headers as Record<string, string>)['x-request-id']).toBeDefined();
  });

  it('retries idempotent requests on 503 and succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(client(fetchImpl).request({ path: '/x' })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never retries a non-idempotent POST', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(503, {}));
    await expect(client(fetchImpl).request({ method: 'POST', path: '/x', body: {} })).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry 4xx and surfaces the upstream problem', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      json(404, { type: 'about:blank', title: 'Not Found', status: 404, code: 'not_found' }),
    );
    const error = await client(fetchImpl)
      .request({ path: '/x' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).upstreamStatus).toBe(404);
    expect((error as UpstreamError).upstreamProblem?.code).toBe('not_found');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out slow dependencies and opens the circuit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason as Error);
          });
        }),
    );
    const slow = client(fetchImpl, { timeoutMs: 20, maxRetries: 0, breaker: { failureThreshold: 2 } });
    await expect(slow.request({ path: '/x' })).rejects.toMatchObject({ status: 504 });
    await expect(slow.request({ path: '/x' })).rejects.toMatchObject({ status: 504 });
    await expect(slow.request({ path: '/x' })).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects absolute or traversal paths (SSRF guard)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(client(fetchImpl).request({ path: 'http://evil.example/' })).rejects.toThrow(/unsafe path/);
    await expect(client(fetchImpl).request({ path: '//evil.example/' })).rejects.toThrow(/unsafe path/);
    await expect(client(fetchImpl).request({ path: '/a/../../etc' })).rejects.toThrow(/unsafe path/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
