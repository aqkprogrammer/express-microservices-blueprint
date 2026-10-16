import { randomUUID } from 'node:crypto';
import { problemDetailsSchema } from '@emb/contracts';
import type { Logger } from '@emb/logger';
import { getRequestContext } from '@emb/logger';
import { counter, gauge, histogram } from '@emb/observability';
import type { z } from 'zod';
import { backoffDelay, sleep } from './backoff.js';
import { CircuitBreaker, CircuitOpenError, type CircuitBreakerOptions } from './circuit-breaker.js';
import { ServiceUnavailableError, UpstreamError } from './errors.js';

const clientRequests = counter('http_client_requests_total', 'Outgoing HTTP requests', [
  'target',
  'method',
  'outcome',
]);
const clientDuration = histogram('http_client_request_duration_seconds', 'Outgoing HTTP request latency', [
  'target',
  'method',
]);
const circuitStateGauge = gauge('http_client_circuit_open', '1 when the circuit to a target is open', [
  'target',
]);

export interface ServiceClientOptions {
  /** Logical name used in logs, metrics and errors (e.g. `product-service`). */
  target: string;
  baseUrl: string;
  timeoutMs?: number;
  /** Retries for idempotent requests only. */
  maxRetries?: number;
  breaker?: CircuitBreakerOptions;
  /** Static headers added to every request (e.g. the internal service token). */
  headers?: Record<string, string>;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions<TSchema extends z.ZodType | undefined = undefined> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path relative to `baseUrl`; absolute URLs are rejected (SSRF guard). */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Response body schema; the parsed value is returned. */
  schema?: TSchema;
  /**
   * Allows retries for non-GET requests that are safe to repeat (e.g. carrying
   * an idempotency key). POSTs without this flag are never retried.
   */
  idempotent?: boolean;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'DELETE']);

class RetryableResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`retryable upstream status ${status}`);
  }
}

/**
 * Typed HTTP client for synchronous service-to-service calls with a per-call
 * timeout, bounded retries for idempotent requests, a circuit breaker,
 * correlation-ID propagation and W3C trace-context injection.
 */
export class ServiceClient {
  private readonly breaker: CircuitBreaker;
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ServiceClientOptions) {
    this.base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(this.base.protocol))
      throw new Error(`Unsupported protocol for ${options.target}`);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.breaker = new CircuitBreaker(options.target, {
      ...options.breaker,
      onStateChange: (state) => {
        circuitStateGauge.set({ target: options.target }, state === 'open' ? 1 : 0);
        options.logger.warn({ target: options.target, state }, 'circuit breaker state changed');
        options.breaker?.onStateChange?.(state);
      },
    });
  }

  get circuitState() {
    return this.breaker.currentState;
  }

  async request<TSchema extends z.ZodType | undefined = undefined>(
    request: RequestOptions<TSchema>,
  ): Promise<TSchema extends z.ZodType ? z.output<TSchema> : unknown> {
    const method = request.method ?? 'GET';
    const url = this.buildUrl(request.path, request.query);
    const retryable = IDEMPOTENT_METHODS.has(method) || request.idempotent === true;
    const maxAttempts = retryable ? (this.options.maxRetries ?? 2) + 1 : 1;
    const timer = clientDuration.startTimer({ target: this.options.target, method });

    for (let attempt = 1; ; attempt += 1) {
      try {
        const body = await this.breaker.execute(
          () => this.send(method, url, request),
          // 4xx answers are the caller's problem, not a sign the dependency is unhealthy.
          (error) => !(error instanceof UpstreamError && (error.upstreamStatus ?? 500) < 500),
        );
        clientRequests.inc({ target: this.options.target, method, outcome: 'success' });
        timer();
        const parsed: unknown = request.schema ? request.schema.parse(body) : body;
        return parsed as TSchema extends z.ZodType ? z.output<TSchema> : unknown;
      } catch (error) {
        const canRetry =
          attempt < maxAttempts && (error instanceof RetryableResponseError || isNetworkOrTimeout(error));
        if (canRetry) {
          const delay = backoffDelay(attempt, 100, 2_000);
          this.options.logger.warn(
            { target: this.options.target, attempt, delay },
            'retrying upstream request',
          );
          await sleep(delay);
          continue;
        }
        timer();
        throw this.normalize(error, method);
      }
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): URL {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) {
      throw new Error(`Refusing unsafe path for ${this.options.target}`);
    }
    const url = new URL(path, this.base);
    // Defence in depth: the resolved URL must stay on the configured origin.
    if (url.origin !== this.base.origin)
      throw new Error(`Refusing cross-origin request for ${this.options.target}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async send(
    method: string,
    url: URL,
    request: RequestOptions<z.ZodType | undefined>,
  ): Promise<unknown> {
    const context = getRequestContext();
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-request-id': randomUUID(),
      ...(context ? { 'x-correlation-id': context.correlationId } : {}),
      ...this.options.headers,
      ...request.headers,
    };
    // W3C trace context is injected by the undici (fetch) instrumentation.
    let body: string | undefined;
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 3_000),
      redirect: 'error',
    });
    const text = await response.text();
    const payload: unknown = text.length > 0 ? safeJson(text) : undefined;
    if (response.ok) return payload;
    if (RETRYABLE_STATUS.has(response.status)) throw new RetryableResponseError(response.status, payload);
    const problem = problemDetailsSchema.safeParse(payload);
    throw new UpstreamError(
      this.options.target,
      response.status,
      `${this.options.target} responded with ${response.status}`,
      undefined,
      problem.success ? problem.data : undefined,
    );
  }

  private normalize(error: unknown, method: string): Error {
    const outcome =
      error instanceof CircuitOpenError
        ? 'circuit_open'
        : isNetworkOrTimeout(error)
          ? 'network_error'
          : 'http_error';
    clientRequests.inc({ target: this.options.target, method, outcome });
    if (error instanceof CircuitOpenError) {
      return new ServiceUnavailableError(`${this.options.target} is temporarily unavailable`, error);
    }
    if (error instanceof UpstreamError) return error;
    if (error instanceof RetryableResponseError) {
      return new UpstreamError(
        this.options.target,
        error.status,
        `${this.options.target} responded with ${error.status}`,
      );
    }
    if (isNetworkOrTimeout(error)) {
      return new UpstreamError(
        this.options.target,
        undefined,
        `${this.options.target} did not respond in time`,
        error,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isNetworkOrTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError;
}
