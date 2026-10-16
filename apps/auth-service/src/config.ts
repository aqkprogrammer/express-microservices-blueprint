import { baseEnvSchema, booleanFromString, loadConfig } from '@emb/config';
import { z } from 'zod';

export const configSchema = baseEnvSchema.extend({
  SERVICE_NAME: z.string().default('auth-service'),
  PORT: z.coerce.number().int().default(3001),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_URL: z.string().min(1),
  /** ES256 private key (PKCS#8 PEM). Use JWT_PRIVATE_KEY_FILE with Docker/Kubernetes secrets. */
  JWT_PRIVATE_KEY: z.string().min(1),
  /** Optional previous public key (SPKI PEM) kept in the JWKS during key rotation. */
  JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(30 * 86_400)
    .default(7 * 86_400),
  PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().min(300).max(3_600).default(900),
  /** Base URL of the (out-of-scope) web app page that accepts the reset token. */
  PASSWORD_RESET_URL: z.url().default('http://localhost:8080/reset-password'),
  MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(20).default(5),
  LOCKOUT_SECONDS: z.coerce.number().int().min(60).default(900),
  /** Secure cookies require HTTPS; disable only for plain-HTTP local development. */
  COOKIE_SECURE: booleanFromString(true),
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(12).optional(),
});

export type AuthConfig = z.infer<typeof configSchema>;
export const loadAuthConfig = (source: NodeJS.ProcessEnv = process.env) => loadConfig(configSchema, source);
