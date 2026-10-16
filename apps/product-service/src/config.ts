import { baseEnvSchema, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('product-service'),
  PORT: z.coerce.number().int().default(3003),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWKS_URL: z.url(),
  INTERNAL_API_TOKEN: z.string().min(32),
  CACHE_DETAIL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  CACHE_LIST_TTL_SECONDS: z.coerce.number().int().positive().default(60),
});

export type ProductConfig = z.infer<typeof configSchema>;
export const loadProductConfig = (source: NodeJS.ProcessEnv = process.env) =>
  loadConfig(configSchema, source);
