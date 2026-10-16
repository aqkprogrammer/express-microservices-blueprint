import { baseEnvSchema, booleanFromString, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('worker'),
  PORT: z.coerce.number().int().default(3009),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(5),
  RABBITMQ_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWKS_URL: z.url(),
  SCHEDULER_ENABLED: booleanFromString(true),
  /** Max dead-lettered messages archived concurrently. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  JOB_RUN_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
});

export type WorkerConfig = z.infer<typeof configSchema>;
export const loadWorkerConfig = (source: NodeJS.ProcessEnv = process.env) => loadConfig(configSchema, source);
