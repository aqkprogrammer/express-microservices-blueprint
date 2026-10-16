import { createServiceApp, type HealthCheck } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import type { AccessTokenVerifier } from '@emb/security';
import type { Express } from 'express';
import type { ProductConfig } from './config.js';
import type { ProductService } from './domain/product-service.js';
import { productOpenApi } from './http/openapi.js';
import { productRoutes } from './http/routes.js';

export interface ProductAppDeps {
  config: Pick<
    ProductConfig,
    | 'SERVICE_NAME'
    | 'HTTP_BODY_LIMIT'
    | 'TRUST_PROXY'
    | 'CORS_ALLOWED_ORIGINS'
    | 'METRICS_ENABLED'
    | 'DOCS_ENABLED'
    | 'INTERNAL_API_TOKEN'
  >;
  logger: Logger;
  service: ProductService;
  verifier: AccessTokenVerifier;
  readinessChecks: HealthCheck[];
  isShuttingDown?: () => boolean;
}

export function buildProductApp(deps: ProductAppDeps): Express {
  const document = productOpenApi();
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
    routes: (app) => {
      app.use(
        productRoutes({
          service: deps.service,
          verifier: deps.verifier,
          internalToken: deps.config.INTERNAL_API_TOKEN,
        }),
      );
    },
  });
}

export { productOpenApi };
