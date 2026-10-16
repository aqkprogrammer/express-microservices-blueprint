import { createServiceApp, type HealthCheck } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import type { AccessTokenVerifier } from '@emb/security';
import type { Express } from 'express';
import type { OrderConfig } from './config.js';
import type { OrderService } from './domain/order-service.js';
import { orderOpenApi } from './http/openapi.js';
import { orderRoutes } from './http/routes.js';

export interface OrderAppDeps {
  config: Pick<
    OrderConfig,
    | 'SERVICE_NAME'
    | 'HTTP_BODY_LIMIT'
    | 'TRUST_PROXY'
    | 'CORS_ALLOWED_ORIGINS'
    | 'METRICS_ENABLED'
    | 'DOCS_ENABLED'
  >;
  logger: Logger;
  service: OrderService;
  verifier: AccessTokenVerifier;
  readinessChecks: HealthCheck[];
  isShuttingDown?: () => boolean;
}

export function buildOrderApp(deps: OrderAppDeps): Express {
  const document = orderOpenApi();
  return createServiceApp({
    serviceName: deps.config.SERVICE_NAME,
    logger: deps.logger,
    bodyLimit: deps.config.HTTP_BODY_LIMIT,
    trustProxy: deps.config.TRUST_PROXY,
    corsAllowedOrigins: deps.config.CORS_ALLOWED_ORIGINS,
    metricsEnabled: deps.config.METRICS_ENABLED,
    docsEnabled: deps.config.DOCS_ENABLED,
    readinessChecks: deps.readinessChecks,
    ...(deps.isShuttingDown ? { isShuttingDown: deps.isShuttingDown } : {}),
    openApiDocument: () => document,
    routes: (app) => app.use(orderRoutes({ service: deps.service, verifier: deps.verifier })),
  });
}

export { orderOpenApi };
