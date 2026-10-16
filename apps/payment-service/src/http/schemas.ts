import { SIMULATED_PAYMENT_TOKENS, currencySchema } from '@emb/contracts';
import { z } from 'zod';
import { PAYMENT_STATUSES } from '../domain/payment.js';

export const paymentSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    customerId: z.uuid(),
    amountCents: z.number().int(),
    currency: z.string(),
    status: z.enum(PAYMENT_STATUSES),
    failureReason: z.string().nullable(),
    capturedCents: z.number().int(),
    refundedCents: z.number().int(),
    authorizationAttempts: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Payment' });

export const createIntentSchema = z
  .object({
    orderId: z.uuid(),
    customerId: z.uuid(),
    amountCents: z.number().int().min(1).max(100_000_000),
    currency: currencySchema.default('USD'),
    /** Simulated token; real card data is never accepted. */
    paymentMethodToken: z.enum(SIMULATED_PAYMENT_TOKENS),
  })
  .meta({ id: 'CreatePaymentIntentRequest' });

export const refundSchema = z
  .object({ amountCents: z.number().int().min(1).optional(), reason: z.string().trim().min(3).max(200) })
  .meta({ id: 'RefundRequest' });

export const paymentIdParams = z.object({ paymentId: z.uuid() });
export const orderIdParams = z.object({ orderId: z.uuid() });
export const listPaymentsQuery = z.object({ orderId: z.uuid() });
