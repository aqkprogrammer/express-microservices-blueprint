import { enqueueEvent } from '@emb/database';
import { getRequestContext } from '@emb/logger';
import type { Prisma } from '../generated/prisma/client.js';
import { canTransition, type OrderStatus, type SagaStep } from './order.js';
import type { OrderDto } from './schemas.js';

export type Tx = Prisma.TransactionClient;
export type OrderWithRelations = Prisma.OrderGetPayload<{ include: { lines: true; saga: true } }>;

export const PRODUCER = 'order-service';
export const orderEventMeta = (orderId: string) => ({
  producer: PRODUCER,
  aggregateType: 'order',
  aggregateId: orderId,
});

/**
 * Loads an order with a row lock. Saga events for the same order are
 * processed concurrently by the consumer; the lock serialises them.
 */
export async function lockOrder(tx: Tx, orderId: string): Promise<OrderWithRelations | null> {
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id::text FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.order.findUnique({ where: { id: orderId }, include: { lines: true, saga: true } });
}

export interface TransitionOptions {
  reason?: string;
  actor: 'customer' | 'system' | 'admin';
  data?: Prisma.OrderUpdateInput;
}

/** Applies a validated status transition and records it in the order history. */
export async function transitionOrder(
  tx: Tx,
  order: OrderWithRelations,
  to: OrderStatus,
  options: TransitionOptions,
): Promise<void> {
  const from = order.status as OrderStatus;
  if (!canTransition(from, to)) throw new Error(`Illegal order transition ${from} → ${to}`);
  await tx.order.update({
    where: { id: order.id },
    data: { ...options.data, status: to, version: { increment: 1 } },
  });
  await tx.orderStatusHistory.create({
    data: {
      orderId: order.id,
      fromStatus: from,
      toStatus: to,
      reason: options.reason ?? null,
      actor: options.actor,
      causationId: getRequestContext()?.causationId ?? getRequestContext()?.requestId ?? null,
    },
  });
  order.status = to;
}

export async function setSagaStep(
  tx: Tx,
  orderId: string,
  step: SagaStep,
  data: Prisma.OrderSagaUpdateInput = {},
): Promise<void> {
  const terminal = step === 'COMPLETED' || step === 'COMPENSATED';
  await tx.orderSaga.update({
    where: { orderId },
    data: { ...data, step, ...(terminal ? { deadlineAt: null, completedAt: new Date() } : {}) },
  });
}

export async function emitOrderCancelled(
  tx: Tx,
  order: OrderWithRelations,
  reason:
    | 'out_of_stock'
    | 'payment_failed'
    | 'reservation_expired'
    | 'inventory_timeout'
    | 'customer_requested'
    | 'admin_requested',
  previousStatus: string,
  cancelledBy: 'customer' | 'system' | 'admin',
): Promise<void> {
  await enqueueEvent(
    tx,
    'OrderCancelled',
    { orderId: order.id, customerId: order.customerId, reason, previousStatus, cancelledBy },
    orderEventMeta(order.id),
  );
}

export function toOrderDto(order: OrderWithRelations): OrderDto {
  return {
    id: order.id,
    customerId: order.customerId,
    status: order.status as OrderStatus,
    currency: order.currency,
    totalCents: order.totalCents,
    lines: order.lines.map((line) => ({
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
    })),
    paymentId: order.paymentId,
    cancellationReason: order.cancellationReason,
    reviewReason: order.reviewReason,
    saga: order.saga
      ? {
          step: order.saga.step as SagaStep,
          deadlineAt: order.saga.deadlineAt?.toISOString() ?? null,
          paymentAttempts: order.saga.paymentAttempts,
        }
      : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}
