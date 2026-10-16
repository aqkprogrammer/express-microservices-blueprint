import { z } from 'zod';

/** Parses "true"/"false"/"1"/"0" (case-insensitive). Environment variables are always strings. */
export const booleanFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'TRUE', 'FALSE'])
    .optional()
    .transform((value) =>
      value === undefined ? defaultValue : value.toLowerCase() === 'true' || value === '1',
    );

export const commaSeparatedList = (defaultValue: string[] = []) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? defaultValue
        : value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
    );

/** A positive integer number of milliseconds with a default. */
export const durationMs = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);

/**
 * Settings every service shares. Each service extends this schema with its own
 * variables so a missing or malformed value fails fast at startup.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SHUTDOWN_TIMEOUT_MS: durationMs(15_000),
  HTTP_BODY_LIMIT: z.string().default('100kb'),
  TRUST_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
  CORS_ALLOWED_ORIGINS: commaSeparatedList([]),
  METRICS_ENABLED: booleanFromString(true),
  DOCS_ENABLED: booleanFromString(true),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;
