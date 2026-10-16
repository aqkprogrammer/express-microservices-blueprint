import { createServiceApp, type HealthCheck } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import type { AccessTokenVerifier } from '@emb/security';
import type { Express } from 'express';
import type { PaymentConfig } from './config.js';
import type { IdempotencyStore } from './domain/idempotency.js';
import type { PaymentService } from './domain/payment-service.js';
import { paymentOpenApi } from './http/openapi.js';
import { paymentRoutes } from './http/routes.js';

export interface PaymentAppDeps {
  config: Pick<
    PaymentConfig,
    | 'SERVICE_NAME'
    | 'HTTP_BODY_LIMIT'
    | 'TRUST_PROXY'
    | 'CORS_ALLOWED_ORIGINS'
    | 'METRICS_ENABLED'
    | 'DOCS_ENABLED'
    | 'INTERNAL_API_TOKEN'
  >;
  logger: Logger;
  service: PaymentService;
  idempotency: IdempotencyStore;
  verifier: AccessTokenVerifier;
  readinessChecks: HealthCheck[];
  isShuttingDown?: () => boolean;
}

export function buildPaymentApp(deps: PaymentAppDeps): Express {
  const document = paymentOpenApi();
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
    routes: (app) =>
      app.use(
        paymentRoutes({
          service: deps.service,
          idempotency: deps.idempotency,
          verifier: deps.verifier,
          internalToken: deps.config.INTERNAL_API_TOKEN,
        }),
      ),
  });
}

export { paymentOpenApi };
