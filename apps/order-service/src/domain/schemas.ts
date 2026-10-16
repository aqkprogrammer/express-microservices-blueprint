import { simulatedPaymentTokenSchema } from '@emb/contracts';
import { paginationQuerySchema } from '@emb/http-kit';
import { z } from 'zod';
import { ORDER_STATUSES, SAGA_STEPS } from './order.js';

export const createOrderSchema = z
  .object({
    lines: z
      .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(1).max(100) }))
      .min(1)
      .max(100),
    /** Simulated token interpreted by the local payment simulator. */
    paymentMethodToken: simulatedPaymentTokenSchema.default('sim_card_approved'),
  })
  .meta({ id: 'CreateOrderRequest' });
export type CreateOrderInput = z.output<typeof createOrderSchema>;

export const orderLineSchema = z.object({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int(),
  unitPriceCents: z.number().int(),
  lineTotalCents: z.number().int(),
});

export const orderSchema = z
  .object({
    id: z.uuid(),
    customerId: z.uuid(),
    status: z.enum(ORDER_STATUSES),
    currency: z.string(),
    totalCents: z.number().int(),
    lines: z.array(orderLineSchema),
    paymentId: z.uuid().nullable(),
    cancellationReason: z.string().nullable(),
    reviewReason: z.string().nullable(),
    saga: z
      .object({
        step: z.enum(SAGA_STEPS),
        deadlineAt: z.string().nullable(),
        paymentAttempts: z.number().int(),
      })
      .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Order' });
export type OrderDto = z.infer<typeof orderSchema>;

export const orderHistorySchema = z
  .array(
    z.object({
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      reason: z.string().nullable(),
      actor: z.string(),
      createdAt: z.string(),
    }),
  )
  .meta({ id: 'OrderHistory' });

export const listOrdersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  /** Admin only: filter by customer. */
  customerId: z.uuid().optional(),
});

export const orderIdParams = z.object({ orderId: z.uuid() });
