import { randomUUID } from 'node:crypto';
import type { EventPayload } from '@emb/contracts';
import { enqueueEvent, isUniqueViolation, markMessageProcessed } from '@emb/database';
import { ConflictError, NotFoundError, UnprocessableError, paginated } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { counter } from '@emb/observability';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import {
  cancellationAction,
  confirmationAction,
  normalizeLines,
  shouldAttemptReservation,
  type RequestedLine,
  type ReservationStatus,
} from './reservation.js';

const PRODUCER = 'inventory-service';
const reservationOutcomes = counter('inventory_reservations_total', 'Reservation attempts by outcome', [
  'outcome',
]);

type Tx = Prisma.TransactionClient;
interface StockRow {
  product_id: string;
  on_hand: number;
  reserved: number;
}

class InsufficientStock extends Error {
  constructor(public readonly reason: 'insufficient_stock' | 'unknown_product') {
    super(reason);
  }
}

const meta = (orderOrProductId: string, aggregateType = 'reservation') => ({
  producer: PRODUCER,
  aggregateType,
  aggregateId: orderOrProductId,
});

export interface InventoryServiceDeps {
  prisma: PrismaClient;
  logger: Logger;
  reservationTtlMs: number;
  onEventsCommitted: () => void;
}

/**
 * Inventory consistency model:
 *  - Each stock change is a single conditional UPDATE (`on_hand - reserved >= qty`)
 *    inside a transaction, so concurrent reservations cannot oversell; the
 *    row lock taken by the UPDATE serialises writers per product.
 *  - Multi-line reservations are all-or-nothing (rollback on the first shortfall).
 *  - CHECK constraints (reserved <= on_hand, on_hand >= 0) are the final guard.
 *  - Every handler records the message ID in the same transaction, so
 *    redelivered messages are no-ops.
 */
export class InventoryService {
  constructor(private readonly deps: InventoryServiceDeps) {}

  // ── Saga participants ──────────────────────────────────────────────────────

  async handleOrderCreated(messageId: string, payload: EventPayload<'OrderCreated'>): Promise<void> {
    const lines = normalizeLines(payload.lines);
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        if (!(await markMessageProcessed(tx, 'inventory.order-created', messageId))) return;
        const existing = await tx.reservation.findUnique({ where: { orderId: payload.orderId } });
        if (!shouldAttemptReservation(existing?.status as ReservationStatus | undefined)) {
          this.deps.logger.info(
            { orderId: payload.orderId, status: existing?.status },
            'reservation already decided; skipping',
          );
          return;
        }
        const changed: StockRow[] = [];
        for (const line of lines) {
          const rows = await tx.$queryRaw<StockRow[]>`
            UPDATE inventory_items
               SET reserved = reserved + ${line.quantity}, version = version + 1, updated_at = now()
             WHERE product_id = ${line.productId}::uuid AND on_hand - reserved >= ${line.quantity}
         RETURNING product_id::text, on_hand, reserved`;
          if (rows.length === 0) {
            const item = await tx.inventoryItem.findUnique({ where: { productId: line.productId } });
            throw new InsufficientStock(item ? 'insufficient_stock' : 'unknown_product');
          }
          changed.push(...rows);
        }
        const reservationId = randomUUID();
        const expiresAt = new Date(Date.now() + this.deps.reservationTtlMs);
        await tx.reservation.create({
          data: {
            id: reservationId,
            orderId: payload.orderId,
            status: 'RESERVED',
            expiresAt,
            lines: { create: lines },
          },
        });
        await enqueueEvent(
          tx,
          'InventoryReserved',
          { orderId: payload.orderId, reservationId, expiresAt: expiresAt.toISOString(), lines },
          meta(payload.orderId),
        );
        await this.emitStockChanged(tx, changed);
        reservationOutcomes.inc({ outcome: 'reserved' });
      });
    } catch (error) {
      if (error instanceof InsufficientStock) {
        await this.recordReservationFailure(messageId, payload.orderId, lines, error.reason);
        return;
      }
      // A concurrent duplicate delivery won the race on the unique order_id.
      if (isUniqueViolation(error)) return;
      throw error;
    }
    this.deps.onEventsCommitted();
  }

  private async recordReservationFailure(
    messageId: string,
    orderId: string,
    lines: RequestedLine[],
    reason: 'insufficient_stock' | 'unknown_product',
  ): Promise<void> {
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        if (!(await markMessageProcessed(tx, 'inventory.order-created', messageId))) return;
        const items = await tx.inventoryItem.findMany({
          where: { productId: { in: lines.map((l) => l.productId) } },
        });
        const available = new Map(items.map((item) => [item.productId, item.onHand - item.reserved]));
        const unavailable = lines
          .filter((line) => (available.get(line.productId) ?? 0) < line.quantity)
          .map((line) => ({
            productId: line.productId,
            requested: line.quantity,
            available: available.get(line.productId) ?? 0,
          }));
        await tx.reservation.create({
          data: { id: randomUUID(), orderId, status: 'REJECTED', failureReason: reason },
        });
        await enqueueEvent(tx, 'InventoryReservationFailed', { orderId, reason, unavailable }, meta(orderId));
      });
      reservationOutcomes.inc({ outcome: 'rejected' });
      this.deps.onEventsCommitted();
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }

  async handleOrderConfirmed(messageId: string, payload: EventPayload<'OrderConfirmed'>): Promise<void> {
    let commitFailed = false;
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        if (!(await markMessageProcessed(tx, 'inventory.order-confirmed', messageId))) return;
        const reservation = await tx.reservation.findUnique({
          where: { orderId: payload.orderId },
          include: { lines: true },
        });
        const action = confirmationAction(reservation?.status as ReservationStatus | undefined);
        if (action === 'already_committed') return;
        if (!reservation || action === 'cannot_commit') throw new InsufficientStock('insufficient_stock');

        const changed: StockRow[] = [];
        for (const line of normalizeLines(reservation.lines)) {
          const rows =
            action === 'commit_reserved'
              ? await tx.$queryRaw<StockRow[]>`
                  UPDATE inventory_items
                     SET on_hand = on_hand - ${line.quantity}, reserved = reserved - ${line.quantity},
                         version = version + 1, updated_at = now()
                   WHERE product_id = ${line.productId}::uuid AND reserved >= ${line.quantity}
               RETURNING product_id::text, on_hand, reserved`
              : // Reservation expired: take stock directly if it is still available.
                await tx.$queryRaw<StockRow[]>`
                  UPDATE inventory_items
                     SET on_hand = on_hand - ${line.quantity}, version = version + 1, updated_at = now()
                   WHERE product_id = ${line.productId}::uuid AND on_hand - reserved >= ${line.quantity}
               RETURNING product_id::text, on_hand, reserved`;
          if (rows.length === 0) throw new InsufficientStock('insufficient_stock');
          changed.push(...rows);
        }
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: 'COMMITTED', expiresAt: null },
        });
        await enqueueEvent(
          tx,
          'InventoryCommitted',
          { orderId: payload.orderId, reservationId: reservation.id },
          meta(payload.orderId),
        );
        await this.emitStockChanged(tx, changed);
      });
    } catch (error) {
      if (!(error instanceof InsufficientStock)) throw error;
      commitFailed = true;
    }
    if (commitFailed) {
      await this.deps.prisma.$transaction(async (tx) => {
        if (!(await markMessageProcessed(tx, 'inventory.order-confirmed', messageId))) return;
        await enqueueEvent(
          tx,
          'InventoryCommitFailed',
          { orderId: payload.orderId, reason: 'reservation expired and stock is no longer available' },
          meta(payload.orderId),
        );
      });
      this.deps.logger.error(
        { orderId: payload.orderId },
        'confirmed order could not be committed from stock',
      );
    }
    this.deps.onEventsCommitted();
  }

  /** Compensation for OrderCancelled. Safe to run in any order relative to OrderCreated. */
  async handleOrderCancelled(messageId: string, payload: EventPayload<'OrderCancelled'>): Promise<void> {
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        if (!(await markMessageProcessed(tx, 'inventory.order-cancelled', messageId))) return;
        const reservation = await tx.reservation.findUnique({
          where: { orderId: payload.orderId },
          include: { lines: true },
        });
        const action = cancellationAction(reservation?.status as ReservationStatus | undefined);
        if (action === 'none') return;
        if (action === 'tombstone' || !reservation) {
          await tx.reservation.create({
            data: { id: randomUUID(), orderId: payload.orderId, status: 'CANCELLED' },
          });
          return;
        }
        const changed: StockRow[] = [];
        for (const line of normalizeLines(reservation.lines)) {
          const rows =
            action === 'release_reserved'
              ? await tx.$queryRaw<StockRow[]>`
                  UPDATE inventory_items SET reserved = reserved - ${line.quantity}, version = version + 1, updated_at = now()
                   WHERE product_id = ${line.productId}::uuid
               RETURNING product_id::text, on_hand, reserved`
              : await tx.$queryRaw<StockRow[]>`
                  UPDATE inventory_items SET on_hand = on_hand + ${line.quantity}, version = version + 1, updated_at = now()
                   WHERE product_id = ${line.productId}::uuid
               RETURNING product_id::text, on_hand, reserved`;
          changed.push(...rows);
        }
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: 'RELEASED', expiresAt: null },
        });
        await enqueueEvent(
          tx,
          'InventoryReleased',
          { orderId: payload.orderId, reservationId: reservation.id, reason: 'order_cancelled' },
          meta(payload.orderId),
        );
        await this.emitStockChanged(tx, changed);
        reservationOutcomes.inc({ outcome: 'released' });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    this.deps.onEventsCommitted();
  }

  async handleProductCreated(messageId: string, payload: EventPayload<'ProductCreated'>): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      if (!(await markMessageProcessed(tx, 'inventory.product-created', messageId))) return;
      await tx.$executeRaw`
        INSERT INTO inventory_items (product_id, sku, updated_at) VALUES (${payload.productId}::uuid, ${payload.sku}, now())
        ON CONFLICT (product_id) DO NOTHING`;
    });
  }

  /** Scheduled maintenance: release reservations whose TTL passed without confirmation. */
  async expireReservations(batchSize = 100): Promise<number> {
    let expired = 0;
    for (;;) {
      const done = await this.deps.prisma.$transaction(async (tx) => {
        const due = await tx.$queryRaw<{ id: string; order_id: string }[]>`
          SELECT id::text, order_id::text FROM reservations
           WHERE status = 'RESERVED' AND expires_at < now()
           ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const reservation = due[0];
        if (!reservation) return true;
        const lines = await tx.reservationLine.findMany({ where: { reservationId: reservation.id } });
        const changed: StockRow[] = [];
        for (const line of normalizeLines(lines)) {
          changed.push(
            ...(await tx.$queryRaw<StockRow[]>`
              UPDATE inventory_items SET reserved = reserved - ${line.quantity}, version = version + 1, updated_at = now()
               WHERE product_id = ${line.productId}::uuid
           RETURNING product_id::text, on_hand, reserved`),
          );
        }
        await tx.reservation.update({ where: { id: reservation.id }, data: { status: 'EXPIRED' } });
        const ids = { orderId: reservation.order_id, reservationId: reservation.id };
        await enqueueEvent(tx, 'InventoryReservationExpired', ids, meta(reservation.order_id));
        await enqueueEvent(
          tx,
          'InventoryReleased',
          { ...ids, reason: 'expired' },
          meta(reservation.order_id),
        );
        await this.emitStockChanged(tx, changed);
        return false;
      });
      if (done) break;
      expired += 1;
      reservationOutcomes.inc({ outcome: 'expired' });
      if (expired >= batchSize) break;
    }
    if (expired > 0) {
      this.deps.logger.info({ expired }, 'expired stale reservations');
      this.deps.onEventsCommitted();
    }
    return expired;
  }

  // ── Admin API ──────────────────────────────────────────────────────────────

  async createItem(input: { productId: string; sku: string; onHand: number }, actorId: string) {
    try {
      const item = await this.deps.prisma.$transaction(async (tx) => {
        const created = await tx.inventoryItem.create({
          data: { productId: input.productId, sku: input.sku, onHand: 0 },
        });
        if (input.onHand === 0) return created;
        return this.applyAdjustment(tx, input.productId, input.onHand, 'initial stock', actorId);
      });
      this.deps.onEventsCommitted();
      return toStockDto(item);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Inventory for this product already exists');
      throw error;
    }
  }

  async adjust(productId: string, delta: number, reason: string, actorId: string) {
    const item = await this.deps.prisma.$transaction((tx) =>
      this.applyAdjustment(tx, productId, delta, reason, actorId),
    );
    this.deps.onEventsCommitted();
    return toStockDto(item);
  }

  private async applyAdjustment(tx: Tx, productId: string, delta: number, reason: string, actorId: string) {
    // Stock that is reserved for open orders cannot be removed.
    const rows = await tx.$queryRaw<StockRow[]>`
      UPDATE inventory_items SET on_hand = on_hand + ${delta}, version = version + 1, updated_at = now()
       WHERE product_id = ${productId}::uuid AND on_hand + ${delta} >= reserved
   RETURNING product_id::text, on_hand, reserved`;
    if (rows.length === 0) {
      const exists = await tx.inventoryItem.findUnique({ where: { productId } });
      if (!exists) throw new NotFoundError('Inventory item not found');
      throw new UnprocessableError(
        'Adjustment would drop on-hand stock below reserved stock',
        'insufficient_stock',
      );
    }
    await tx.stockAdjustment.create({ data: { id: randomUUID(), productId, delta, reason, actorId } });
    await this.emitStockChanged(tx, rows);
    return tx.inventoryItem.findUniqueOrThrow({ where: { productId } });
  }

  async getItem(productId: string) {
    const item = await this.deps.prisma.inventoryItem.findUnique({ where: { productId } });
    if (!item) throw new NotFoundError('Inventory item not found');
    return toStockDto(item);
  }

  async listItems(page: number, pageSize: number, lowStockThreshold?: number) {
    const items =
      lowStockThreshold === undefined
        ? await this.deps.prisma.inventoryItem.findMany({
            orderBy: { sku: 'asc' },
            skip: (page - 1) * pageSize,
            take: pageSize,
          })
        : await this.deps.prisma.$queryRaw<
            {
              productId: string;
              sku: string;
              onHand: number;
              reserved: number;
              version: number;
              updatedAt: Date;
            }[]
          >`SELECT product_id::text AS "productId", sku, on_hand AS "onHand", reserved, version, updated_at AS "updatedAt"
              FROM inventory_items WHERE on_hand - reserved <= ${lowStockThreshold}
             ORDER BY sku LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const total =
      lowStockThreshold === undefined
        ? await this.deps.prisma.inventoryItem.count()
        : Number(
            (
              await this.deps.prisma.$queryRaw<{ count: bigint }[]>`
                SELECT count(*) FROM inventory_items WHERE on_hand - reserved <= ${lowStockThreshold}`
            )[0]?.count ?? 0,
          );
    return paginated(items.map(toStockDto), total, page, pageSize);
  }

  async getReservation(orderId: string) {
    const reservation = await this.deps.prisma.reservation.findUnique({
      where: { orderId },
      include: { lines: true },
    });
    if (!reservation) throw new NotFoundError('Reservation not found');
    return {
      id: reservation.id,
      orderId: reservation.orderId,
      status: reservation.status,
      expiresAt: reservation.expiresAt?.toISOString() ?? null,
      failureReason: reservation.failureReason,
      lines: reservation.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
      createdAt: reservation.createdAt.toISOString(),
      updatedAt: reservation.updatedAt.toISOString(),
    };
  }

  private async emitStockChanged(tx: Tx, rows: StockRow[]): Promise<void> {
    for (const row of rows) {
      await enqueueEvent(
        tx,
        'InventoryStockChanged',
        {
          productId: row.product_id,
          onHand: row.on_hand,
          reserved: row.reserved,
          available: row.on_hand - row.reserved,
        },
        meta(row.product_id, 'inventory_item'),
      );
    }
  }
}

export function toStockDto(item: {
  productId: string;
  sku: string;
  onHand: number;
  reserved: number;
  version: number;
  updatedAt: Date;
}) {
  return {
    productId: item.productId,
    sku: item.sku,
    onHand: item.onHand,
    reserved: item.reserved,
    available: item.onHand - item.reserved,
    version: item.version,
    updatedAt: item.updatedAt.toISOString(),
  };
}
