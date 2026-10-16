import { baseEnvSchema, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('audit-service'),
  PORT: z.coerce.number().int().default(3008),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(5),
  RABBITMQ_URL: z.string().min(1),
  JWKS_URL: z.url(),
  /** Records older than this are deleted by the scheduled retention task. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(365),
});

export type AuditConfig = z.infer<typeof configSchema>;
export const loadAuditConfig = (source: NodeJS.ProcessEnv = process.env) => loadConfig(configSchema, source);
