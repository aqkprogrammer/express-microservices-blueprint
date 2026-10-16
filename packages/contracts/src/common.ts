import { z } from 'zod';

export const ROLES = ['customer', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** ISO-4217 currency code. The demo uses a single currency, but the contract carries it explicitly. */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

/** Money is always integer minor units (cents) to avoid floating point rounding. */
export const amountCentsSchema = z.number().int().nonnegative();

export const uuidSchema = z.uuid();

/** Simulated payment-method tokens accepted by the local payment simulator. Never card numbers. */
export const SIMULATED_PAYMENT_TOKENS = [
  'sim_card_approved',
  'sim_card_declined',
  'sim_insufficient_funds',
  'sim_provider_timeout',
  'sim_transient_error',
] as const;
export const simulatedPaymentTokenSchema = z.enum(SIMULATED_PAYMENT_TOKENS);
export type SimulatedPaymentToken = z.infer<typeof simulatedPaymentTokenSchema>;

/** RFC 9457 Problem Details as returned by every service. */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
