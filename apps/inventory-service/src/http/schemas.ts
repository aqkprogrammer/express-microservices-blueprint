import { paginationQuerySchema } from '@emb/http-kit';
import { z } from 'zod';

export const stockSchema = z
  .object({
    productId: z.uuid(),
    sku: z.string(),
    onHand: z.number().int(),
    reserved: z.number().int(),
    available: z.number().int(),
    version: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Stock' });

export const reservationSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    status: z.enum(['RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED', 'REJECTED', 'CANCELLED']),
    expiresAt: z.string().nullable(),
    failureReason: z.string().nullable(),
    lines: z.array(z.object({ productId: z.uuid(), quantity: z.number().int() })),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Reservation' });

export const productIdParams = z.object({ productId: z.uuid() });
export const orderIdParams = z.object({ orderId: z.uuid() });

export const createInventorySchema = z
  .object({
    productId: z.uuid(),
    sku: z.string().trim().min(3).max(40),
    onHand: z.number().int().min(0).max(1_000_000).default(0),
  })
  .meta({ id: 'CreateInventoryRequest' });

export const adjustmentSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((value) => value !== 0, 'delta must not be zero'),
    reason: z.string().trim().min(3).max(200),
  })
  .meta({ id: 'StockAdjustmentRequest' });

export const listInventoryQuerySchema = paginationQuerySchema.extend({
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
});
