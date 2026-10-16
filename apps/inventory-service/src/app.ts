import { createServiceApp, type HealthCheck } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import type { AccessTokenVerifier } from '@emb/security';
import type { Express } from 'express';
import type { InventoryConfig } from './config.js';
import type { InventoryService } from './domain/inventory-service.js';
import { inventoryOpenApi } from './http/openapi.js';
import { inventoryRoutes } from './http/routes.js';

export interface InventoryAppDeps {
  config: Pick<
    InventoryConfig,
    | 'SERVICE_NAME'
    | 'HTTP_BODY_LIMIT'
    | 'TRUST_PROXY'
    | 'CORS_ALLOWED_ORIGINS'
    | 'METRICS_ENABLED'
    | 'DOCS_ENABLED'
  >;
  logger: Logger;
  service: InventoryService;
  verifier: AccessTokenVerifier;
  readinessChecks: HealthCheck[];
  isShuttingDown?: () => boolean;
}

export function buildInventoryApp(deps: InventoryAppDeps): Express {
  const document = inventoryOpenApi();
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
    routes: (app) => app.use(inventoryRoutes({ service: deps.service, verifier: deps.verifier })),
  });
}

export { inventoryOpenApi };
