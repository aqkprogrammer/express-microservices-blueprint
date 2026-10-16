import { baseEnvSchema, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('payment-service'),
  PORT: z.coerce.number().int().default(3006),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_URL: z.string().min(1),
  JWKS_URL: z.url(),
  INTERNAL_API_TOKEN: z.string().min(32),
  /** Simulated provider round-trip latency. */
  SIMULATOR_LATENCY_MS: z.coerce.number().int().min(0).max(30_000).default(50),
  /** How long the simulator's "timeout" scenario keeps the outcome unknown. */
  SIMULATOR_TIMEOUT_RESOLVES_AFTER_MS: z.coerce.number().int().min(0).default(20_000),
  /** PROCESSING payments older than this are reconciled against the provider. */
  RECONCILE_AFTER_MS: z.coerce.number().int().min(0).default(20_000),
  CONSUMER_PREFETCH: z.coerce.number().int().min(1).max(500).default(10),
});

export type PaymentConfig = z.infer<typeof configSchema>;
export const loadPaymentConfig = (source: NodeJS.ProcessEnv = process.env) =>
  loadConfig(configSchema, source);
