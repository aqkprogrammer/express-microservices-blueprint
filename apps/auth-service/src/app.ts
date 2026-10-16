import { createServiceApp, type HealthCheck } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import type { AccessTokenVerifier } from '@emb/security';
import type { Express } from 'express';
import type { AuthConfig } from './config.js';
import type { AuthService } from './domain/auth-service.js';
import type { SigningMaterial } from './domain/tokens.js';
import { authOpenApi } from './http/openapi.js';
import { authRoutes } from './http/routes.js';

export interface AuthAppDeps {
  config: Pick<
    AuthConfig,
    | 'SERVICE_NAME'
    | 'HTTP_BODY_LIMIT'
    | 'TRUST_PROXY'
    | 'CORS_ALLOWED_ORIGINS'
    | 'METRICS_ENABLED'
    | 'DOCS_ENABLED'
    | 'COOKIE_SECURE'
    | 'REFRESH_TOKEN_TTL_SECONDS'
  >;
  logger: Logger;
  service: AuthService;
  signing: SigningMaterial;
  verifier: AccessTokenVerifier;
  readinessChecks: HealthCheck[];
  isShuttingDown?: () => boolean;
}

export function buildAuthApp(deps: AuthAppDeps): Express {
  const document = authOpenApi();
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
        authRoutes({
          service: deps.service,
          verifier: deps.verifier,
          signing: deps.signing,
          cookieSecure: deps.config.COOKIE_SECURE,
          refreshTokenTtlSeconds: deps.config.REFRESH_TOKEN_TTL_SECONDS,
        }),
      ),
  });
}

export { authOpenApi };
