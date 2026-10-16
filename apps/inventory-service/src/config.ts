import { baseEnvSchema, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('inventory-service'),
  PORT: z.coerce.number().int().default(3004),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_URL: z.string().min(1),
  JWKS_URL: z.url(),
  /** How long stock stays reserved for an unconfirmed order. */
  RESERVATION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60_000),
  CONSUMER_PREFETCH: z.coerce.number().int().min(1).max(500).default(10),
});

export type InventoryConfig = z.infer<typeof configSchema>;
export const loadInventoryConfig = (source: NodeJS.ProcessEnv = process.env) =>
  loadConfig(configSchema, source);
