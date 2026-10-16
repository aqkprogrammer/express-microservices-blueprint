import type { Request } from 'express';
import { z } from 'zod';
import { ValidationError } from './errors.js';

/** Parses `data` with `schema`, converting Zod issues into a 400 problem with field paths. */
export function parseWith<TSchema extends z.ZodType>(
  schema: TSchema,
  data: unknown,
  location: 'body' | 'query' | 'params' | 'headers' = 'body',
): z.output<TSchema> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new ValidationError(
    `Invalid request ${location}`,
    result.error.issues.map((issue) => ({
      path: [location, ...issue.path.map(String)].join('.'),
      message: issue.message,
    })),
  );
}

/** Opaque client-generated key; UUIDs are recommended. */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]');

export function requireIdempotencyKey(req: Request): string {
  const header = req.header('idempotency-key');
  if (!header) throw new ValidationError('The Idempotency-Key header is required for this operation');
  return parseWith(idempotencyKeySchema, header, 'headers');
}
