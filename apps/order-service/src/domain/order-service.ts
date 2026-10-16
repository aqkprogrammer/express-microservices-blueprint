import { randomUUID } from 'node:crypto';
import { enqueueEvent, isUniqueViolation } from '@emb/database';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, paginated } from '@emb/http-kit';
import { counter } from '@emb/observability';
import type { Principal } from '@emb/security';
import type { ProductClient } from '../clients/product-client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  canAdminCancel,
  canCustomerCancel,
  mergeRequestedLines,
  requestFingerprint,
  totalCents,
  type OrderStatus,
} from './order.js';
import {
  emitOrderCancelled,
  lockOrder,
  orderEventMeta,
  setSagaStep,
  toOrderDto,
  transitionOrder,
} from './order-repository.js';
import type { CreateOrderInput, OrderDto } from './schemas.js';

const ordersCreated = counter('orders_created_total', 'Orders accepted', ['replayed']);

export interface OrderServiceDeps {
  prisma: PrismaClient;
  products: ProductClient;
  inventoryTimeoutMs: number;
  maxLines: number;
  onEventsCommitted: () => void;
  onSagaFinished: (
    outcome: 'confirmed' | 'cancelled' | 'requires_review',
    reason: string,
    startedAt: Date,
  ) => void;
}

export class OrderService {
  constructor(private readonly deps: OrderServiceDeps) {}

  /**
   * Idempotent order creation. The (customer, Idempotency-Key) pair is unique:
   * repeating a request returns the original order; reusing a key with a
   * different payload is rejected. Prices are snapshotted from product-service
   * and the order, its saga state and OrderCreated are committed atomically.
   */
  async create(
    customerId: string,
    idempotencyKey: string,
    input: CreateOrderInput,
  ): Promise<{ order: OrderDto; replayed: boolean }> {
    const fingerprint = requestFingerprint(input);
    const existing = await this.findByIdempotencyKey(customerId, idempotencyKey, fingerprint);
    if (existing) return { order: existing, replayed: true };

    const lines = mergeRequestedLines(input.lines);
    if (lines.length > this.deps.maxLines)
      throw new UnprocessableError(`An order may contain at most ${this.deps.maxLines} products`);
    const snapshots = await this.deps.products.getSnapshots(lines.map((line) => line.productId));
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    const priced = lines.map((line) => {
      const product = byId.get(line.productId);
      if (!product)
        throw new UnprocessableError(`Product ${line.productId} does not exist`, 'unknown_product');
      if (product.status !== 'active')
        throw new UnprocessableError(
          `Product ${product.sku} is not available for sale`,
          'product_unavailable',
        );
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        quantity: line.quantity,
        unitPriceCents: product.priceCents,
        currency: product.currency,
      };
    });
    const currencies = new Set(priced.map((line) => line.currency));
    if (currencies.size !== 1)
      throw new UnprocessableError('All products in an order must share one currency', 'mixed_currency');
    const currency = [...currencies][0] ?? 'USD';
    const total = totalCents(priced);
    const orderId = randomUUID();

    try {
      const order = await this.deps.prisma.$transaction(async (tx) => {
        await tx.order.create({
          data: {
            id: orderId,
            customerId,
            status: 'PENDING',
            currency,
            totalCents: total,
            paymentMethodToken: input.paymentMethodToken,
            idempotencyKey,
            requestHash: fingerprint,
            lines: {
              create: priced.map(({ currency: _currency, ...line }) => ({
                ...line,
                lineTotalCents: line.quantity * line.unitPriceCents,
              })),
            },
            history: { create: { toStatus: 'PENDING', actor: 'customer', reason: 'order placed' } },
            saga: {
              create: {
                step: 'AWAITING_INVENTORY',
                deadlineAt: new Date(Date.now() + this.deps.inventoryTimeoutMs),
              },
            },
          },
        });
        await enqueueEvent(
          tx,
          'OrderCreated',
          {
            orderId,
            customerId,
            currency,
            totalCents: total,
            lines: priced.map(({ currency: _currency, ...line }) => line),
          },
          { ...orderEventMeta(orderId), correlationId: orderId },
        );
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true, saga: true } });
      });
      this.deps.onEventsCommitted();
      ordersCreated.inc({ replayed: 'false' });
      return { order: toOrderDto(order), replayed: false };
    } catch (error) {
      // Two concurrent requests with the same key: the loser returns the winner's order.
      if (isUniqueViolation(error)) {
        const winner = await this.findByIdempotencyKey(customerId, idempotencyKey, fingerprint);
        if (winner) return { order: winner, replayed: true };
      }
      throw error;
    }
  }

  private async findByIdempotencyKey(customerId: string, idempotencyKey: string, fingerprint: string) {
    const order = await this.deps.prisma.order.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      include: { lines: true, saga: true },
    });
    if (!order) return null;
    if (order.requestHash !== fingerprint) {
      throw new UnprocessableError(
        'This Idempotency-Key was already used with a different request body',
        'idempotency_key_reused',
      );
    }
    ordersCreated.inc({ replayed: 'true' });
    return toOrderDto(order);
  }

  async get(orderId: string, auth: Principal): Promise<OrderDto> {
    const order = await this.deps.prisma.order.findUnique({
      where: { id: orderId },
      include: { lines: true, saga: true },
    });
    // Return 404 rather than 403 for other customers' orders to avoid leaking existence.
    if (!order || (order.customerId !== auth.userId && !auth.roles.includes('admin')))
      throw new NotFoundError('Order not found');
    return toOrderDto(order);
  }

  async history(orderId: string, auth: Principal) {
    await this.get(orderId, auth);
    const entries = await this.deps.prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
    });
    return entries.map((entry) => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      reason: entry.reason,
      actor: entry.actor,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  async list(
    auth: Principal,
    query: {
      page: number;
      pageSize: number;
      status?: OrderStatus | undefined;
      customerId?: string | undefined;
    },
  ) {
    const admin = auth.roles.includes('admin');
    if (query.customerId && !admin && query.customerId !== auth.userId) throw new ForbiddenError();
    const where = {
      customerId: admin ? query.customerId : auth.userId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await this.deps.prisma.$transaction([
      this.deps.prisma.order.findMany({
        where,
        include: { lines: true, saga: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.deps.prisma.order.count({ where }),
    ]);
    return paginated(rows.map(toOrderDto), total, query.page, query.pageSize);
  }

  /** Customer or admin cancellation; compensation (release stock, void/refund) follows via OrderCancelled. */
  async cancel(orderId: string, auth: Principal): Promise<OrderDto> {
    const admin = auth.roles.includes('admin');
    let startedAt: Date | undefined;
    const order = await this.deps.prisma.$transaction(async (tx) => {
      const current = await lockOrder(tx, orderId);
      if (!current || (current.customerId !== auth.userId && !admin))
        throw new NotFoundError('Order not found');
      const status = current.status as OrderStatus;
      const allowed = admin ? canAdminCancel(status) : canCustomerCancel(status);
      if (!allowed)
        throw new ConflictError(`Order in status ${status} cannot be cancelled`, 'invalid_order_state');
      const actor = admin && current.customerId !== auth.userId ? 'admin' : 'customer';
      const reason = actor === 'admin' ? 'admin_requested' : 'customer_requested';
      await transitionOrder(tx, current, 'CANCELLED', {
        actor,
        reason,
        data: { cancellationReason: reason },
      });
      if (current.saga && !['COMPLETED', 'COMPENSATED'].includes(current.saga.step)) {
        startedAt = current.saga.startedAt;
        await setSagaStep(tx, orderId, 'COMPENSATED');
      }
      await emitOrderCancelled(tx, current, reason, status, actor);
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true, saga: true } });
    });
    this.deps.onEventsCommitted();
    if (startedAt) this.deps.onSagaFinished('cancelled', order.cancellationReason ?? 'cancelled', startedAt);
    return toOrderDto(order);
  }
}
