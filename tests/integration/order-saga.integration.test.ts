import { randomUUID } from 'node:crypto';
import { startPostgres, type StartedDependency } from '@emb/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentClient } from '../../apps/order-service/src/clients/payment-client.js';
import type { ProductClient } from '../../apps/order-service/src/clients/product-client.js';
import type { PaymentLookup } from '../../apps/order-service/src/domain/order.js';
import { OrderSaga } from '../../apps/order-service/src/domain/order-saga.js';
import { OrderService } from '../../apps/order-service/src/domain/order-service.js';
import { PrismaClient } from '../../apps/order-service/src/generated/prisma/client.js';
import { createServiceDatabase, prismaFor, silentLogger } from './helpers.js';

let postgres: StartedDependency;
let db: ReturnType<typeof prismaFor<PrismaClient>>;
let orders: OrderService;
let lookup: PaymentLookup | Error = { status: 'NOT_FOUND' };
const PRODUCT = {
  id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001',
  sku: 'KB-MECH-001',
  name: 'Keyboard',
  priceCents: 12_900,
  currency: 'USD',
  status: 'active',
};
const customer = {
  userId: randomUUID(),
  roles: ['customer' as const],
  sessionId: randomUUID(),
  tokenId: 'jti',
};

const products = { getSnapshots: async () => [PRODUCT] } as unknown as ProductClient;
const payments = {
  lookupByOrder: async () => {
    if (lookup instanceof Error) throw lookup;
    return lookup;
  },
} as unknown as PaymentClient;

/** A fresh saga instance each time simulates an orchestrator restart: all state comes from Postgres. */
const saga = (paymentTimeoutMs = 60_000) =>
  new OrderSaga({
    prisma: db.client,
    payments,
    logger: silentLogger,
    paymentTimeoutMs,
    maxPaymentAttempts: 3,
    onEventsCommitted: () => undefined,
  });

async function placeOrder() {
  const { order } = await orders.create(customer.userId, `key-${randomUUID()}`, {
    lines: [{ productId: PRODUCT.id, quantity: 2 }],
    paymentMethodToken: 'sim_card_approved',
  });
  return order.id;
}
const reserved = (orderId: string) => ({
  orderId,
  reservationId: randomUUID(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  lines: [{ productId: PRODUCT.id, quantity: 2 }],
});
const state = async (orderId: string) => {
  const order = await db.client.order.findUniqueOrThrow({ where: { id: orderId }, include: { saga: true } });
  return {
    status: order.status,
    step: order.saga?.step,
    attempts: order.saga?.paymentAttempts,
    reason: order.cancellationReason ?? order.reviewReason,
  };
};
const events = async (orderId: string) =>
  (
    await db.client.outboxEvent.findMany({ where: { aggregateId: orderId }, orderBy: { createdAt: 'asc' } })
  ).map((row) => row.eventType);

beforeAll(async () => {
  postgres = await startPostgres();
  db = prismaFor(PrismaClient, await createServiceDatabase(postgres, 'order-service'), 'order-it');
  orders = new OrderService({
    prisma: db.client,
    products,
    inventoryTimeoutMs: 60_000,
    maxLines: 20,
    onEventsCommitted: () => undefined,
    onSagaFinished: () => undefined,
  });
}, 240_000);

afterAll(async () => {
  await db?.client.$disconnect();
  await db?.close();
  await postgres?.stop();
});

describe('order saga orchestration (real Postgres)', () => {
  it('creates orders idempotently with price snapshots and OrderCreated in the outbox', async () => {
    const key = `key-${randomUUID()}`;
    const input = {
      lines: [{ productId: PRODUCT.id, quantity: 2 }],
      paymentMethodToken: 'sim_card_approved' as const,
    };
    const first = await orders.create(customer.userId, key, input);
    const replay = await orders.create(customer.userId, key, input);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, order: { id: first.order.id } });
    expect(first.order).toMatchObject({
      status: 'PENDING',
      totalCents: 25_800,
      lines: [{ unitPriceCents: 12_900, lineTotalCents: 25_800 }],
    });
    expect(await events(first.order.id)).toEqual(['OrderCreated.v1']);
    await expect(
      orders.create(customer.userId, key, { ...input, lines: [{ productId: PRODUCT.id, quantity: 3 }] }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'idempotency_key_reused',
    });
  });

  it('confirms after inventory and payment succeed, surviving an orchestrator restart between steps', async () => {
    const orderId = await placeOrder();
    await saga().onInventoryReserved(randomUUID(), reserved(orderId));
    expect(await state(orderId)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      step: 'AWAITING_PAYMENT',
      attempts: 1,
    });
    await saga().onPaymentAuthorized(randomUUID(), {
      paymentId: randomUUID(),
      orderId,
      amountCents: 25_800,
      currency: 'USD',
    });
    expect(await state(orderId)).toMatchObject({ status: 'CONFIRMED', step: 'COMPLETED' });
    expect(await events(orderId)).toEqual([
      'OrderCreated.v1',
      'PaymentAuthorizationRequested.v1',
      'OrderConfirmed.v1',
    ]);
  });

  it('compensates when the payment fails', async () => {
    const orderId = await placeOrder();
    await saga().onInventoryReserved(randomUUID(), reserved(orderId));
    await saga().onPaymentFailed(randomUUID(), { paymentId: randomUUID(), orderId, reason: 'declined' });
    expect(await state(orderId)).toMatchObject({
      status: 'CANCELLED',
      step: 'COMPENSATED',
      reason: 'payment_failed',
    });
    expect((await events(orderId)).at(-1)).toBe('OrderCancelled.v1');
  });

  it('cancels when inventory cannot be reserved', async () => {
    const orderId = await placeOrder();
    await saga().onInventoryReservationFailed(randomUUID(), {
      orderId,
      reason: 'insufficient_stock',
      unavailable: [],
    });
    expect(await state(orderId)).toMatchObject({ status: 'CANCELLED', reason: 'out_of_stock' });
  });

  it('ignores duplicate and out-of-order events', async () => {
    const orderId = await placeOrder();
    const messageId = randomUUID();
    await saga().onInventoryReserved(messageId, reserved(orderId));
    await saga().onInventoryReserved(messageId, reserved(orderId)); // same message
    await saga().onInventoryReserved(randomUUID(), reserved(orderId)); // duplicate fact, new message
    await saga().onPaymentFailed(randomUUID(), { paymentId: randomUUID(), orderId, reason: 'declined' });
    await saga().onPaymentAuthorized(randomUUID(), {
      paymentId: randomUUID(),
      orderId,
      amountCents: 1,
      currency: 'USD',
    }); // late, after cancel
    expect(await state(orderId)).toMatchObject({ status: 'CANCELLED', attempts: 1 });
    expect(
      (await events(orderId)).filter((type) => type === 'PaymentAuthorizationRequested.v1'),
    ).toHaveLength(1);
    expect(await events(orderId)).not.toContain('OrderConfirmed.v1');
  });

  it('cancels a saga whose inventory step timed out', async () => {
    const orderId = await placeOrder();
    await db.client.orderSaga.update({
      where: { orderId },
      data: { deadlineAt: new Date(Date.now() - 1_000) },
    });
    await saga().checkTimeouts();
    expect(await state(orderId)).toMatchObject({ status: 'CANCELLED', reason: 'inventory_timeout' });
  });

  describe('payment step timeout → reconciliation (a timeout is not a failure)', () => {
    async function timedOutOrder() {
      const orderId = await placeOrder();
      await saga().onInventoryReserved(randomUUID(), reserved(orderId));
      await db.client.orderSaga.update({
        where: { orderId },
        data: { deadlineAt: new Date(Date.now() - 1_000) },
      });
      return orderId;
    }

    it('confirms when the payment service reports the authorization actually succeeded', async () => {
      const orderId = await timedOutOrder();
      lookup = { status: 'AUTHORIZED', paymentId: randomUUID() };
      await saga().checkTimeouts();
      expect(await state(orderId)).toMatchObject({ status: 'CONFIRMED' });
    });

    it('re-requests authorization while the outcome is unknown, then escalates to manual review', async () => {
      const orderId = await timedOutOrder();
      lookup = { status: 'PENDING' };
      for (const expectedAttempts of [2, 3]) {
        await saga().checkTimeouts();
        expect(await state(orderId)).toMatchObject({
          status: 'AWAITING_PAYMENT',
          attempts: expectedAttempts,
        });
        await db.client.orderSaga.update({
          where: { orderId },
          data: { deadlineAt: new Date(Date.now() - 1_000) },
        });
      }
      await saga().checkTimeouts();
      expect(await state(orderId)).toMatchObject({ status: 'REQUIRES_REVIEW', step: 'REQUIRES_REVIEW' });
      expect((await events(orderId)).at(-1)).toBe('OrderRequiresReview.v1');
      // A late authorization still resolves the review automatically.
      await saga().onPaymentAuthorized(randomUUID(), {
        paymentId: randomUUID(),
        orderId,
        amountCents: 25_800,
        currency: 'USD',
      });
      expect(await state(orderId)).toMatchObject({ status: 'CONFIRMED' });
    });

    it('keeps waiting (no state change) when the payment service is unreachable', async () => {
      const orderId = await timedOutOrder();
      lookup = new Error('connect ECONNREFUSED');
      await saga().checkTimeouts();
      const after = await db.client.orderSaga.findUniqueOrThrow({ where: { orderId } });
      expect(await state(orderId)).toMatchObject({ status: 'AWAITING_PAYMENT', attempts: 1 });
      expect(after.deadlineAt!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('lets customers cancel and only their own orders', async () => {
    const orderId = await placeOrder();
    const stranger = { ...customer, userId: randomUUID() };
    await expect(orders.cancel(orderId, stranger)).rejects.toMatchObject({ status: 404 });
    await expect(orders.cancel(orderId, customer)).resolves.toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'customer_requested',
    });
    await expect(orders.cancel(orderId, customer)).rejects.toMatchObject({ status: 409 });
  });
});
