import { AppError, NotFoundError, createServiceApp, type HealthCheck } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { renderMetrics } from '@emb/observability';
import express, { type Express, type RequestHandler } from 'express';
import { rateLimit, type Store } from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import type { GatewayConfig } from './config.js';
import { UpstreamProxy } from './proxy.js';
import {
  ROUTES,
  UnsafePathError,
  matchRoute,
  normalizePath,
  upstreamUrls,
  type UpstreamName,
} from './routes.js';

export interface GatewayDeps {
  config: GatewayConfig;
  logger: Logger;
  /** Shared rate-limit stores (Redis in production; memory in tests). */
  rateLimitStores?: { global?: Store; strict?: Store };
  readinessChecks?: HealthCheck[];
  isShuttingDown?: () => boolean;
  fetchImpl?: typeof fetch;
}

const SERVICE_DOCS: { upstream: UpstreamName; title: string }[] = [
  { upstream: 'auth', title: 'Auth' },
  { upstream: 'user', title: 'Users' },
  { upstream: 'product', title: 'Products' },
  { upstream: 'inventory', title: 'Inventory' },
  { upstream: 'order', title: 'Orders' },
  { upstream: 'payment', title: 'Payments (simulator)' },
  { upstream: 'notification', title: 'Notifications' },
  { upstream: 'audit', title: 'Audit' },
];

function limiter(config: GatewayConfig, max: number, store: Store | undefined): RequestHandler {
  return rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // If Redis is unreachable, availability wins over rate limiting (documented trade-off).
    passOnStoreError: true,
    ...(store ? { store } : {}),
    handler: (_req, _res, next) => {
      next(new AppError(429, 'rate_limited', 'Too many requests, please slow down'));
    },
  });
}

/** The gateway: cross-cutting edge concerns and routing only — no business logic, no databases. */
export function buildGatewayApp(deps: GatewayDeps): Express {
  const { config, logger } = deps;
  const urls = upstreamUrls(config);
  const proxies = Object.fromEntries(
    (Object.keys(urls) as UpstreamName[]).map((name) => [
      name,
      new UpstreamProxy({
        name: `${name}-service`,
        baseUrl: urls[name],
        timeoutMs: config.UPSTREAM_TIMEOUT_MS,
        logger,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      }),
    ]),
  ) as Record<UpstreamName, UpstreamProxy>;
  const globalLimiter = limiter(config, config.RATE_LIMIT_MAX, deps.rateLimitStores?.global);
  const strictLimiter = limiter(config, config.AUTH_RATE_LIMIT_MAX, deps.rateLimitStores?.strict);
  const bufferBody = express.raw({ limit: config.HTTP_BODY_LIMIT, type: () => true });

  const specCache = new Map<UpstreamName, { body: unknown; at: number }>();

  return createServiceApp({
    serviceName: config.SERVICE_NAME,
    logger,
    bodyParser: 'none',
    trustProxy: config.TRUST_PROXY,
    corsAllowedOrigins: config.CORS_ALLOWED_ORIGINS,
    // Public port never serves metrics; see buildMetricsApp.
    metricsEnabled: false,
    readinessChecks: deps.readinessChecks ?? [],
    ...(deps.isShuttingDown ? { isShuttingDown: deps.isShuttingDown } : {}),
    routes: (app) => {
      if (config.DOCS_ENABLED) {
        // Aggregated Swagger UI: one dropdown entry per service spec, fetched through the gateway.
        app.get('/docs/specs/:service.json', async (req, res) => {
          const entry = SERVICE_DOCS.find((doc) => doc.upstream === req.params.service);
          if (!entry) throw new NotFoundError('Unknown service');
          const cached = specCache.get(entry.upstream);
          if (cached && Date.now() - cached.at < 60_000) {
            res.json(cached.body);
            return;
          }
          const response = await (deps.fetchImpl ?? fetch)(new URL('/openapi.json', urls[entry.upstream]), {
            signal: AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS),
          }).catch(() => undefined);
          if (!response?.ok)
            throw new AppError(502, 'upstream_unreachable', `${entry.title} spec unavailable`, {
              expose: true,
            });
          const body: unknown = await response.json();
          specCache.set(entry.upstream, { body, at: Date.now() });
          res.json(body);
        });
        app.use(
          '/docs',
          swaggerUi.serve,
          swaggerUi.setup(undefined, {
            explorer: true,
            customSiteTitle: 'Express Microservices Blueprint API',
            swaggerOptions: {
              urls: SERVICE_DOCS.map((doc) => ({ url: `/docs/specs/${doc.upstream}.json`, name: doc.title })),
            },
          }),
        );
      }

      app.use(async (req, res, next) => {
        let normalized: { pathname: string; search: string };
        try {
          normalized = normalizePath(req.originalUrl);
        } catch (error) {
          if (error instanceof UnsafePathError) {
            next(new AppError(400, 'invalid_path', error.message));
            return;
          }
          throw error;
        }
        const route = matchRoute(normalized.pathname);
        if (!route) {
          next(new NotFoundError(`No route for ${req.method} ${normalized.pathname}`));
          return;
        }
        res.locals.routeLabel = route.label;

        const run = (handler: RequestHandler) =>
          new Promise<void>((resolve, reject) => {
            void handler(req, res, (error?: unknown) => {
              if (error === undefined || error === null) resolve();
              else reject(error instanceof Error ? error : new Error('rate limiter failed'));
            });
          });
        await run(globalLimiter);
        if (res.headersSent) return;
        if (route.strictRateLimit) {
          await run(strictLimiter);
          if (res.headersSent) return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') await run(bufferBody);
        const body = Buffer.isBuffer(req.body) ? req.body : undefined;
        await proxies[route.upstream].forward(req, res, normalized.pathname, normalized.search, body);
      });
    },
  });
}

/** Internal-only listener for Prometheus scrapes (not published outside the private network). */
export function buildMetricsApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    const { contentType, body } = await renderMetrics();
    res.type(contentType).send(body);
  });
  return app;
}

export { ROUTES };
