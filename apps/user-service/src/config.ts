import { baseEnvSchema, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('user-service'),
  PORT: z.coerce.number().int().default(3002),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_URL: z.string().min(1),
  JWKS_URL: z.url(),
});

export type UserConfig = z.infer<typeof configSchema>;
export const loadUserConfig = (source: NodeJS.ProcessEnv = process.env) => loadConfig(configSchema, source);
