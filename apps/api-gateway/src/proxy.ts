import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError, CircuitBreaker, CircuitOpenError, ServiceUnavailableError } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { getRequestContext, serializeError } from '@emb/logger';
import { counter, gauge } from '@emb/observability';
import type { Request, Response } from 'express';

const upstreamErrors = counter('gateway_upstream_errors_total', 'Upstream failures seen by the gateway', [
  'upstream',
  'kind',
]);
const circuitOpen = gauge('gateway_upstream_circuit_open', '1 while the circuit to an upstream is open', [
  'upstream',
]);

/** Hop-by-hop headers (RFC 9110 §7.6.1) plus headers the gateway owns or must never forward. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'expect',
  // Clients must never be able to forge the service-to-service credential.
  'x-internal-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'traceparent',
  'tracestate',
]);
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'trailer',
  // fetch transparently decodes compressed bodies, so these would no longer match.
  'content-encoding',
  'content-length',
  'x-powered-by',
]);

class UpstreamHttpFailure extends Error {
  constructor(public readonly response: globalThis.Response) {
    super(`upstream status ${response.status}`);
  }
}

export interface UpstreamProxyOptions {
  name: string;
  baseUrl: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Streaming reverse proxy for one upstream. Each upstream has its own circuit
 * breaker so a failing service fails fast without affecting other routes.
 * Requests are never retried here: non-idempotent requests must not be
 * replayed by infrastructure, and clients own their retry policy.
 */
export class UpstreamProxy {
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly base: URL;

  constructor(private readonly options: UpstreamProxyOptions) {
    this.base = new URL(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.breaker = new CircuitBreaker(options.name, {
      failureThreshold: 5,
      openDurationMs: 10_000,
      onStateChange: (state) => {
        circuitOpen.set({ upstream: options.name }, state === 'open' ? 1 : 0);
        options.logger.warn({ upstream: options.name, state }, 'upstream circuit state changed');
      },
    });
  }

  async forward(
    req: Request,
    res: Response,
    pathname: string,
    search: string,
    body: Buffer | undefined,
  ): Promise<void> {
    const target = new URL(pathname + search, this.base);
    if (target.origin !== this.base.origin) throw new AppError(400, 'bad_request', 'Invalid path');

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || STRIPPED_REQUEST_HEADERS.has(key)) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const context = getRequestContext();
    if (context) {
      headers.set('x-request-id', context.requestId);
      headers.set('x-correlation-id', context.correlationId);
    }
    headers.set('x-forwarded-for', req.ip ?? '');
    headers.set('x-forwarded-proto', req.protocol);
    headers.set('x-forwarded-host', req.get('host') ?? '');
    // traceparent/tracestate are added by the undici (fetch) instrumentation for the
    // outgoing client span; injecting them here as well would duplicate the header.

    let upstream: globalThis.Response;
    try {
      upstream = await this.breaker.execute(
        async () => {
          const response = await this.fetchImpl(target, {
            method: req.method,
            headers,
            ...(body && body.length > 0 ? { body } : {}),
            redirect: 'manual',
            signal: AbortSignal.timeout(this.options.timeoutMs),
          });
          // 502/503/504 from the upstream count against its circuit, but are still relayed.
          if (response.status === 502 || response.status === 503 || response.status === 504)
            throw new UpstreamHttpFailure(response);
          return response;
        },
        () => true,
      );
    } catch (error) {
      if (error instanceof UpstreamHttpFailure) {
        upstream = error.response;
      } else {
        throw this.translate(error);
      }
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!STRIPPED_RESPONSE_HEADERS.has(key) && key !== 'set-cookie') res.setHeader(key, value);
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader('set-cookie', cookies);

    if (!upstream.body || req.method === 'HEAD') {
      res.end();
      return;
    }
    await new Promise<void>((resolve) => {
      const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>);
      stream.on('error', (error) => {
        upstreamErrors.inc({ upstream: this.options.name, kind: 'stream' });
        this.options.logger.warn(
          { err: serializeError(error), upstream: this.options.name },
          'upstream response stream failed',
        );
        res.destroy(error);
        resolve();
      });
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.pipe(res);
    });
  }

  private translate(error: unknown): AppError {
    if (error instanceof CircuitOpenError) {
      upstreamErrors.inc({ upstream: this.options.name, kind: 'circuit_open' });
      return new ServiceUnavailableError(`${this.options.name} is temporarily unavailable`);
    }
    const name = (error as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      upstreamErrors.inc({ upstream: this.options.name, kind: 'timeout' });
      return new AppError(504, 'upstream_timeout', `${this.options.name} did not respond in time`, {
        expose: true,
      });
    }
    upstreamErrors.inc({ upstream: this.options.name, kind: 'connection' });
    this.options.logger.warn(
      { err: serializeError(error), upstream: this.options.name },
      'upstream connection failed',
    );
    return new AppError(502, 'upstream_unreachable', `${this.options.name} is unreachable`, { expose: true });
  }
}
