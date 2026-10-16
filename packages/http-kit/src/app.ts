import type { Logger } from '@emb/logger';
import { classifyError, getRequestContext, serializeError } from '@emb/logger';
import { renderMetrics } from '@emb/observability';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { ZodError } from 'zod';
import { AppError, NotFoundError, ValidationError, statusTitle, toProblem } from './errors.js';
import { runHealthChecks, type HealthCheck } from './health.js';
import { httpMetricsMiddleware } from './http-metrics.js';
import { requestContextMiddleware } from './request-context.js';

export interface ServiceAppOptions {
  serviceName: string;
  logger: Logger;
  bodyLimit?: string;
  trustProxy?: string | boolean | number;
  corsAllowedOrigins?: string[];
  metricsEnabled?: boolean;
  docsEnabled?: boolean;
  readinessChecks?: HealthCheck[];
  /** Returns true while the process is draining; readiness then reports 503. */
  isShuttingDown?: () => boolean;
  openApiDocument?: () => object;
  /** `none` leaves request bodies unread (the gateway streams them upstream itself). */
  bodyParser?: 'json' | 'none';
  /** Registers the service's routes. */
  routes: (app: Express) => void;
}

const PROBLEM_JSON = 'application/problem+json';

function corsMiddleware(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Correlation-Id, Retry-After, Location');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Correlation-Id',
        );
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const requestId = getRequestContext()?.requestId;
    let appError: AppError;
    if (error instanceof AppError) {
      appError = error;
    } else if (error instanceof ZodError) {
      appError = new ValidationError(
        'Request validation failed',
        error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    } else if (isBodyParserError(error)) {
      appError =
        error.type === 'entity.too.large'
          ? new AppError(413, 'payload_too_large', 'Request body exceeds the size limit')
          : error.type === 'entity.parse.failed'
            ? new AppError(400, 'malformed_json', 'Request body is not valid JSON')
            : new AppError(error.status ?? 400, 'bad_request', 'Request body could not be read');
    } else {
      appError = new AppError(500, 'internal_error', 'Internal server error', {
        expose: false,
        cause: error,
      });
    }

    const logPayload = {
      err: serializeError(error),
      status: appError.status,
      errorClass: classifyError(appError),
    };
    if (appError.status >= 500) logger.error(logPayload, 'request failed');
    else logger.debug(logPayload, 'request rejected');

    for (const [header, value] of Object.entries(appError.options.headers ?? {}))
      res.setHeader(header, value);
    res
      .status(appError.status)
      .type(PROBLEM_JSON)
      .json(toProblem(appError, req.originalUrl.split('?')[0], requestId));
  };
}

function isBodyParserError(error: unknown): error is { type: string; status?: number } {
  return (
    typeof error === 'object' && error !== null && typeof (error as { type?: unknown }).type === 'string'
  );
}

/**
 * Builds an Express app with the cross-cutting concerns every service needs,
 * in a fixed order: security headers → CORS → request context → metrics/logs →
 * operational endpoints → body parsing → service routes → 404 → errors.
 */
export function createServiceApp(options: ServiceAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? 'loopback, linklocal, uniquelocal');
  app.set('query parser', 'simple');

  app.use(helmet());
  app.use(corsMiddleware(options.corsAllowedOrigins ?? []));
  app.use(requestContextMiddleware);
  app.use(httpMetricsMiddleware(options.logger));

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: options.serviceName });
  });
  app.get('/health/ready', async (_req, res) => {
    if (options.isShuttingDown?.()) {
      res.status(503).json({ status: 'unavailable', reason: 'shutting_down' });
      return;
    }
    const report = await runHealthChecks(options.readinessChecks ?? []);
    res.status(report.status === 'unavailable' ? 503 : 200).json({ service: options.serviceName, ...report });
  });
  if (options.metricsEnabled ?? true) {
    app.get('/metrics', async (_req, res) => {
      const { contentType, body } = await renderMetrics();
      res.type(contentType).send(body);
    });
  }
  if (options.openApiDocument) {
    const getDocument = options.openApiDocument;
    app.get('/openapi.json', (_req, res) => {
      res.json(getDocument());
    });
    if (options.docsEnabled ?? true) {
      app.use('/docs', swaggerUi.serve, swaggerUi.setup(undefined, { swaggerUrl: '/openapi.json' }));
    }
  }

  if ((options.bodyParser ?? 'json') === 'json') {
    app.use(
      express.json({
        limit: options.bodyLimit ?? '100kb',
        strict: true,
        type: ['application/json', 'application/*+json'],
      }),
    );
  }

  options.routes(app);

  app.use((req, _res, next) => {
    next(new NotFoundError(`No route for ${req.method} ${req.path}`));
  });
  app.use(errorHandler(options.logger));
  return app;
}

export { statusTitle };
