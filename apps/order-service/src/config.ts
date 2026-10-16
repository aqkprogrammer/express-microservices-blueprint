import { baseEnvSchema, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('order-service'),
  PORT: z.coerce.number().int().default(3005),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_URL: z.string().min(1),
  JWKS_URL: z.url(),
  INTERNAL_API_TOKEN: z.string().min(32),
  PRODUCT_SERVICE_URL: z.url(),
  PAYMENT_SERVICE_URL: z.url(),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  /** Saga step deadlines. Inventory should answer fast; payment providers can be slow. */
  SAGA_INVENTORY_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SAGA_PAYMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Authorization re-requests before the order is parked for manual review. */
  SAGA_MAX_PAYMENT_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  MAX_ORDER_LINES: z.coerce.number().int().min(1).max(100).default(20),
  CONSUMER_PREFETCH: z.coerce.number().int().min(1).max(500).default(10),
});

export type OrderConfig = z.infer<typeof configSchema>;
export const loadOrderConfig = (source: NodeJS.ProcessEnv = process.env) => loadConfig(configSchema, source);
