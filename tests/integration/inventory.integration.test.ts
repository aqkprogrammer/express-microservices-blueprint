import { randomUUID } from 'node:crypto';
import type { EventPayload } from '@emb/contracts';
import { startPostgres, type StartedDependency } from '@emb/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InventoryService } from '../../apps/inventory-service/src/domain/inventory-service.js';
import { PrismaClient } from '../../apps/inventory-service/src/generated/prisma/client.js';
import { createServiceDatabase, prismaFor, silentLogger } from './helpers.js';

let postgres: StartedDependency;
let db: ReturnType<typeof prismaFor<PrismaClient>>;
let service: InventoryService;
const ADMIN = '00000000-0000-4000-8000-0000000000aa';

const orderCreated = (
  productId: string,
  quantity: number,
  orderId = randomUUID(),
): EventPayload<'OrderCreated'> => ({
  orderId,
  customerId: randomUUID(),
  currency: 'USD',
  totalCents: quantity * 100,
  lines: [{ productId, sku: 'SKU', name: 'Item', quantity, unitPriceCents: 100 }],
});
const cancelled = (orderId: string): EventPayload<'OrderCancelled'> => ({
  orderId,
  customerId: randomUUID(),
  reason: 'customer_requested',
  previousStatus: 'CONFIRMED',
  cancelledBy: 'customer',
});
const confirmed = (orderId: string, productId: string, quantity: number): EventPayload<'OrderConfirmed'> => ({
  orderId,
  customerId: randomUUID(),
  currency: 'USD',
  totalCents: quantity * 100,
  paymentId: randomUUID(),
  lines: [{ productId, sku: 'SKU', name: 'Item', quantity, unitPriceCents: 100 }],
});

async function newProduct(onHand: number): Promise<string> {
  const productId = randomUUID();
  await service.createItem({ productId, sku: `SKU-${productId.slice(0, 6)}`, onHand }, ADMIN);
  return productId;
}

const outboxTypes = async (orderId: string) =>
  (
    await db.client.outboxEvent.findMany({ where: { aggregateId: orderId }, orderBy: { createdAt: 'asc' } })
  ).map((row) => row.eventType);

beforeAll(async () => {
  postgres = await startPostgres();
  db = prismaFor(PrismaClient, await createServiceDatabase(postgres, 'inventory-service'), 'inventory-it');
  service = new InventoryService({
    prisma: db.client,
    logger: silentLogger,
    reservationTtlMs: 60_000,
    onEventsCommitted: () => undefined,
  });
}, 240_000);

afterAll(async () => {
  await db?.client.$disconnect();
  await db?.close();
  await postgres?.stop();
});

describe('inventory reservations (real Postgres)', () => {
  it('never oversells under concurrent reservations', async () => {
    const productId = await newProduct(10);
    const orders = Array.from({ length: 40 }, () => orderCreated(productId, 1));
    await Promise.all(orders.map((order) => service.handleOrderCreated(randomUUID(), order)));
    const item = await db.client.inventoryItem.findUniqueOrThrow({ where: { productId } });
    const statuses = await db.client.reservation.groupBy({
      by: ['status'],
      _count: true,
      where: { orderId: { in: orders.map((o) => o.orderId) } },
    });
    expect(item.reserved).toBe(10);
    expect(item.onHand).toBe(10);
    expect(Object.fromEntries(statuses.map((s) => [s.status, s._count]))).toEqual({
      RESERVED: 10,
      REJECTED: 30,
    });
  });

  it('reserves multi-line orders all-or-nothing', async () => {
    const plenty = await newProduct(100);
    const scarce = await newProduct(1);
    const order = orderCreated(plenty, 5);
    order.lines.push({ productId: scarce, sku: 'S', name: 'S', quantity: 2, unitPriceCents: 1 });
    await service.handleOrderCreated(randomUUID(), order);
    expect((await db.client.inventoryItem.findUniqueOrThrow({ where: { productId: plenty } })).reserved).toBe(
      0,
    );
    expect(await outboxTypes(order.orderId)).toEqual(['InventoryReservationFailed.v1']);
  });

  it('processes a redelivered message only once', async () => {
    const productId = await newProduct(5);
    const order = orderCreated(productId, 2);
    const messageId = randomUUID();
    await service.handleOrderCreated(messageId, order);
    await service.handleOrderCreated(messageId, order);
    await service.handleOrderCreated(randomUUID(), order); // same order, different message: still one reservation
    expect((await db.client.inventoryItem.findUniqueOrThrow({ where: { productId } })).reserved).toBe(2);
  });

  it('commits on confirmation and restocks when a confirmed order is cancelled', async () => {
    const productId = await newProduct(5);
    const order = orderCreated(productId, 3);
    await service.handleOrderCreated(randomUUID(), order);
    await service.handleOrderConfirmed(randomUUID(), confirmed(order.orderId, productId, 3));
    let item = await db.client.inventoryItem.findUniqueOrThrow({ where: { productId } });
    expect({ onHand: item.onHand, reserved: item.reserved }).toEqual({ onHand: 2, reserved: 0 });
    await service.handleOrderCancelled(randomUUID(), cancelled(order.orderId));
    item = await db.client.inventoryItem.findUniqueOrThrow({ where: { productId } });
    expect({ onHand: item.onHand, reserved: item.reserved }).toEqual({ onHand: 5, reserved: 0 });
  });

  it('handles cancellation arriving before the order (tombstone)', async () => {
    const productId = await newProduct(5);
    const order = orderCreated(productId, 1);
    await service.handleOrderCancelled(randomUUID(), cancelled(order.orderId));
    await service.handleOrderCreated(randomUUID(), order);
    expect((await db.client.inventoryItem.findUniqueOrThrow({ where: { productId } })).reserved).toBe(0);
    expect(
      (await db.client.reservation.findUniqueOrThrow({ where: { orderId: order.orderId } })).status,
    ).toBe('CANCELLED');
  });

  it('expires stale reservations and publishes the release', async () => {
    const productId = await newProduct(5);
    const order = orderCreated(productId, 4);
    await service.handleOrderCreated(randomUUID(), order);
    await db.client.reservation.update({
      where: { orderId: order.orderId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect(await service.expireReservations()).toBe(1);
    expect((await db.client.inventoryItem.findUniqueOrThrow({ where: { productId } })).reserved).toBe(0);
    expect(await outboxTypes(order.orderId)).toEqual(
      expect.arrayContaining([
        'InventoryReserved.v1',
        'InventoryReservationExpired.v1',
        'InventoryReleased.v1',
      ]),
    );
  });

  it('refuses adjustments that would drop stock below reserved quantity', async () => {
    const productId = await newProduct(3);
    await service.handleOrderCreated(randomUUID(), orderCreated(productId, 2));
    await expect(service.adjust(productId, -2, 'shrinkage', ADMIN)).rejects.toMatchObject({ status: 422 });
    await expect(service.adjust(productId, -1, 'shrinkage', ADMIN)).resolves.toMatchObject({
      onHand: 2,
      reserved: 2,
      available: 0,
    });
  });

  it('is protected by database constraints even if application checks are bypassed', async () => {
    const productId = await newProduct(1);
    await expect(
      db.client.$executeRawUnsafe(
        `UPDATE inventory_items SET reserved = 2 WHERE product_id = $1::uuid`,
        productId,
      ),
    ).rejects.toThrow();
  });
});
