import { baseEnvSchema, booleanFromString, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('notification-service'),
  PORT: z.coerce.number().int().default(3007),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_URL: z.string().min(1),
  JWKS_URL: z.url(),
  /** `smtp` (Mailpit locally, a real relay in production) or `console` (logs a redacted line). */
  EMAIL_TRANSPORT: z.enum(['smtp', 'console']).default('console'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: booleanFromString(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('Express Microservices Blueprint <no-reply@example.test>'),
  /**
   * Development aid: deliveries to this recipient domain fail, to demonstrate
   * retries and dead-lettering. Leave unset in production.
   */
  SIMULATE_FAILURE_DOMAIN: z.string().optional(),
  CONSUMER_PREFETCH: z.coerce.number().int().min(1).max(500).default(10),
});

export type NotificationConfig = z.infer<typeof configSchema>;
export const loadNotificationConfig = (source: NodeJS.ProcessEnv = process.env) =>
  loadConfig(configSchema, source);
