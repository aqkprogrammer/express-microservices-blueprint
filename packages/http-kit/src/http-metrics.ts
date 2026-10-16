import { AsyncResource } from 'node:async_hooks';
import type { Logger } from '@emb/logger';
import { counter, gauge, histogram } from '@emb/observability';
import type { RequestHandler } from 'express';

const requestsTotal = counter('http_requests_total', 'HTTP requests handled', [
  'method',
  'route',
  'status_code',
]);
const requestDuration = histogram('http_request_duration_seconds', 'HTTP request latency', [
  'method',
  'route',
  'status_code',
]);
const inFlight = gauge('http_requests_in_flight', 'HTTP requests currently being handled');

const OPERATIONAL = new Set(['/health/live', '/health/ready', '/metrics']);

/**
 * Records RED metrics and an access log line per request. The `route` label is
 * the matched Express route template (e.g. `/api/v1/orders/:orderId`), never the
 * raw URL, so cardinality stays bounded.
 */
export function httpMetricsMiddleware(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    inFlight.inc();
    // Bound so the access log line keeps the request's correlation context.
    res.on(
      'close',
      AsyncResource.bind(() => {
        inFlight.dec();
        const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
        const routePath = (req.route as { path?: string } | undefined)?.path;
        // Proxies have no Express route; they set an explicit bounded label instead.
        const explicit = typeof res.locals.routeLabel === 'string' ? res.locals.routeLabel : undefined;
        const route =
          explicit ??
          (routePath ? `${req.baseUrl}${routePath}` : OPERATIONAL.has(req.path) ? req.path : 'unmatched');
        const labels = { method: req.method, route, status_code: String(res.statusCode) };
        requestsTotal.inc(labels);
        requestDuration.observe(labels, durationSeconds);
        if (OPERATIONAL.has(req.path)) return;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger[level](
          {
            http: { method: req.method, route, path: req.path, statusCode: res.statusCode },
            durationMs: Math.round(durationSeconds * 1000),
          },
          'request completed',
        );
      }),
    );
    next();
  };
}
