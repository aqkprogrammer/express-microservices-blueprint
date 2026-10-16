import { baseEnvSchema, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('api-gateway'),
  PORT: z.coerce.number().int().default(8080),
  HTTP_BODY_LIMIT: z.string().default('256kb'),
  /** Prometheus metrics are served on this separate, non-public port. */
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  REDIS_URL: z.string().min(1),
  AUTH_SERVICE_URL: z.url(),
  USER_SERVICE_URL: z.url(),
  PRODUCT_SERVICE_URL: z.url(),
  INVENTORY_SERVICE_URL: z.url(),
  ORDER_SERVICE_URL: z.url(),
  PAYMENT_SERVICE_URL: z.url(),
  NOTIFICATION_SERVICE_URL: z.url(),
  AUDIT_SERVICE_URL: z.url(),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  /** Requests per window per client IP across the whole API. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** Stricter limit for credential endpoints (login, register, refresh, password reset). */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
});

export type GatewayConfig = z.infer<typeof configSchema>;
export const loadGatewayConfig = (source: NodeJS.ProcessEnv = process.env) =>
  loadConfig(configSchema, source);
