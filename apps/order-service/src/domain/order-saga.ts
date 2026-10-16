import type { EventPayload } from '@emb/contracts';
import { enqueueEvent, markMessageProcessed } from '@emb/database';
import type { Logger } from '@emb/logger';
import { serializeError } from '@emb/logger';
import { counter, histogram } from '@emb/observability';
import type { PaymentClient } from '../clients/payment-client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { reconcilePayment, type OrderStatus } from './order.js';
import {
  emitOrderCancelled,
  lockOrder,
  orderEventMeta,
  setSagaStep,
  transitionOrder,
  type OrderWithRelations,
  type Tx,
} from './order-repository.js';

const sagaOutcomes = counter('saga_completed_total', 'Order sagas reaching an outcome', [
  'outcome',
  'reason',
]);
const sagaDuration = histogram(
  'saga_duration_seconds',
  'Time from order creation to saga outcome',
  ['outcome'],
  [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
);
const sagaTimeouts = counter('saga_step_timeouts_total', 'Saga steps that exceeded their deadline', [
  'step',
  'decision',
]);
const ignoredEvents = counter(
  'saga_events_ignored_total',
  'Saga events that did not apply to the current order state',
  ['event_type'],
);

export function recordSagaOutcome(
  outcome: 'confirmed' | 'cancelled' | 'requires_review',
  reason: string,
  startedAt: Date,
): void {
  sagaOutcomes.inc({ outcome, reason });
  sagaDuration.observe({ outcome }, (Date.now() - startedAt.getTime()) / 1000);
}

export interface OrderSagaDeps {
  prisma: PrismaClient;
  payments: PaymentClient;
  logger: Logger;
  paymentTimeoutMs: number;
  maxPaymentAttempts: number;
  onEventsCommitted: () => void;
}

type Outcome =
  { outcome: 'confirmed' | 'cancelled' | 'requires_review'; reason: string; startedAt: Date } | undefined;

/**
 * Orchestrated saga: the order service owns the workflow state (order_sagas)
 * and reacts to participant events, issuing the next command or compensation
 * through the outbox. Each handler:
 *   1. records the message ID (duplicates become no-ops),
 *   2. locks the order row (serialises concurrent events for one order),
 *   3. applies the transition only if the state machine allows it,
 *   4. writes follow-up events to the outbox in the same transaction.
 * Because all state is in Postgres, a restarted process resumes exactly where
 * it left off; overdue steps are picked up by `checkTimeouts`.
 */
export class OrderSaga {
  constructor(private readonly deps: OrderSagaDeps) {}

  private async handle(
    consumerName: string,
    messageId: string,
    orderId: string,
    eventType: string,
    apply: (tx: Tx, order: OrderWithRelations) => Promise<Outcome | 'ignored'>,
  ): Promise<void> {
    const result = await this.deps.prisma.$transaction(async (tx) => {
      if (!(await markMessageProcessed(tx, consumerName, messageId))) return 'duplicate' as const;
      const order = await lockOrder(tx, orderId);
      if (!order) {
        this.deps.logger.warn({ orderId, eventType }, 'saga event for unknown order');
        return 'ignored' as const;
      }
      return apply(tx, order);
    });
    if (result === 'ignored') {
      ignoredEvents.inc({ event_type: eventType });
      this.deps.logger.info({ orderId, eventType }, 'saga event did not apply to current order state');
      return;
    }
    if (result === 'duplicate') return;
    this.deps.onEventsCommitted();
    if (result) recordSagaOutcome(result.outcome, result.reason, result.startedAt);
  }

  onInventoryReserved(messageId: string, payload: EventPayload<'InventoryReserved'>) {
    return this.handle(
      'order.inventory-reserved',
      messageId,
      payload.orderId,
      'InventoryReserved',
      async (tx, order) => {
        if (order.status !== 'PENDING') return 'ignored';
        await transitionOrder(tx, order, 'AWAITING_PAYMENT', {
          actor: 'system',
          reason: 'inventory reserved',
          data: { reservationId: payload.reservationId },
        });
        await this.requestPayment(tx, order, 1);
        return undefined;
      },
    );
  }

  onInventoryReservationFailed(messageId: string, payload: EventPayload<'InventoryReservationFailed'>) {
    return this.handle(
      'order.inventory-failed',
      messageId,
      payload.orderId,
      'InventoryReservationFailed',
      async (tx, order) => {
        if (order.status !== 'PENDING') return 'ignored';
        return this.cancel(tx, order, 'out_of_stock', `inventory: ${payload.reason}`);
      },
    );
  }

  onInventoryReservationExpired(messageId: string, payload: EventPayload<'InventoryReservationExpired'>) {
    return this.handle(
      'order.reservation-expired',
      messageId,
      payload.orderId,
      'InventoryReservationExpired',
      async (tx, order) => {
        if (order.status !== 'PENDING' && order.status !== 'AWAITING_PAYMENT') return 'ignored';
        return this.cancel(
          tx,
          order,
          'reservation_expired',
          'stock reservation expired before payment completed',
        );
      },
    );
  }

  onInventoryCommitFailed(messageId: string, payload: EventPayload<'InventoryCommitFailed'>) {
    return this.handle(
      'order.commit-failed',
      messageId,
      payload.orderId,
      'InventoryCommitFailed',
      async (tx, order) => {
        if (order.status !== 'CONFIRMED') return 'ignored';
        return this.requireReview(tx, order, `inventory commit failed: ${payload.reason}`);
      },
    );
  }

  onPaymentAuthorized(messageId: string, payload: EventPayload<'PaymentAuthorized'>) {
    return this.handle(
      'order.payment-authorized',
      messageId,
      payload.orderId,
      'PaymentAuthorized',
      async (tx, order) => {
        // A cancelled order is not resurrected: payment-service voids the authorization on OrderCancelled.
        if (order.status !== 'AWAITING_PAYMENT' && order.status !== 'REQUIRES_REVIEW') return 'ignored';
        return this.confirm(tx, order, payload.paymentId);
      },
    );
  }

  onPaymentFailed(messageId: string, payload: EventPayload<'PaymentFailed'>) {
    return this.handle(
      'order.payment-failed',
      messageId,
      payload.orderId,
      'PaymentFailed',
      async (tx, order) => {
        if (order.status !== 'AWAITING_PAYMENT' && order.status !== 'REQUIRES_REVIEW') return 'ignored';
        return this.cancel(tx, order, 'payment_failed', `payment ${payload.reason}`);
      },
    );
  }

  // ── Steps and compensations ────────────────────────────────────────────────

  private async requestPayment(tx: Tx, order: OrderWithRelations, attempt: number): Promise<void> {
    await setSagaStep(tx, order.id, 'AWAITING_PAYMENT', {
      deadlineAt: new Date(Date.now() + this.deps.paymentTimeoutMs),
      paymentAttempts: attempt,
    });
    await enqueueEvent(
      tx,
      'PaymentAuthorizationRequested',
      {
        orderId: order.id,
        customerId: order.customerId,
        amountCents: order.totalCents,
        currency: order.currency,
        paymentMethodToken: order.paymentMethodToken,
        attempt,
      },
      orderEventMeta(order.id),
    );
  }

  private async confirm(tx: Tx, order: OrderWithRelations, paymentId: string): Promise<Outcome> {
    await transitionOrder(tx, order, 'CONFIRMED', {
      actor: 'system',
      reason: 'payment authorized',
      data: { paymentId, reviewReason: null },
    });
    await setSagaStep(tx, order.id, 'COMPLETED');
    await enqueueEvent(
      tx,
      'OrderConfirmed',
      {
        orderId: order.id,
        customerId: order.customerId,
        currency: order.currency,
        totalCents: order.totalCents,
        paymentId,
        lines: order.lines.map((line) => ({
          productId: line.productId,
          sku: line.sku,
          name: line.name,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
        })),
      },
      orderEventMeta(order.id),
    );
    return {
      outcome: 'confirmed',
      reason: 'payment_authorized',
      startedAt: order.saga?.startedAt ?? order.createdAt,
    };
  }

  private async cancel(
    tx: Tx,
    order: OrderWithRelations,
    reason: 'out_of_stock' | 'payment_failed' | 'reservation_expired' | 'inventory_timeout',
    detail: string,
  ): Promise<Outcome> {
    const previous = order.status;
    await transitionOrder(tx, order, 'CANCELLED', {
      actor: 'system',
      reason: detail,
      data: { cancellationReason: reason },
    });
    await setSagaStep(tx, order.id, 'COMPENSATED');
    // Compensation fan-out: inventory releases stock, payment voids/refunds, notification informs the customer.
    await emitOrderCancelled(tx, order, reason, previous, 'system');
    return { outcome: 'cancelled', reason, startedAt: order.saga?.startedAt ?? order.createdAt };
  }

  private async requireReview(tx: Tx, order: OrderWithRelations, reason: string): Promise<Outcome> {
    await transitionOrder(tx, order, 'REQUIRES_REVIEW', {
      actor: 'system',
      reason,
      data: { reviewReason: reason },
    });
    await setSagaStep(tx, order.id, 'REQUIRES_REVIEW', { deadlineAt: null });
    await enqueueEvent(
      tx,
      'OrderRequiresReview',
      { orderId: order.id, customerId: order.customerId, reason },
      orderEventMeta(order.id),
    );
    return {
      outcome: 'requires_review',
      reason: 'manual_review',
      startedAt: order.saga?.startedAt ?? order.createdAt,
    };
  }

  // ── Timeouts and reconciliation ────────────────────────────────────────────

  /**
   * Scheduled by the worker. Network calls (payment lookups) happen outside any
   * transaction; the decision is then applied under the row lock after
   * re-checking that the saga has not moved on in the meantime.
   */
  async checkTimeouts(limit = 50): Promise<number> {
    const overdue = await this.deps.prisma.orderSaga.findMany({
      where: { step: { in: ['AWAITING_INVENTORY', 'AWAITING_PAYMENT'] }, deadlineAt: { lt: new Date() } },
      orderBy: { deadlineAt: 'asc' },
      take: limit,
    });
    for (const saga of overdue) {
      try {
        if (saga.step === 'AWAITING_INVENTORY') await this.timeoutInventory(saga.orderId);
        else await this.timeoutPayment(saga.orderId);
      } catch (error) {
        this.deps.logger.error(
          { err: serializeError(error), orderId: saga.orderId },
          'saga timeout handling failed',
        );
      }
    }
    return overdue.length;
  }

  private async timeoutInventory(orderId: string): Promise<void> {
    const outcome = await this.deps.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (
        !order?.saga ||
        order.saga.step !== 'AWAITING_INVENTORY' ||
        !order.saga.deadlineAt ||
        order.saga.deadlineAt > new Date()
      ) {
        return undefined;
      }
      sagaTimeouts.inc({ step: 'inventory', decision: 'cancel' });
      // Safe even if inventory reserves later: it releases on OrderCancelled or skips via its tombstone.
      return this.cancel(tx, order, 'inventory_timeout', 'no inventory response before the saga deadline');
    });
    if (outcome) {
      this.deps.onEventsCommitted();
      recordSagaOutcome(outcome.outcome, outcome.reason, outcome.startedAt);
    }
  }

  private async timeoutPayment(orderId: string): Promise<void> {
    let lookup;
    try {
      lookup = await this.deps.payments.lookupByOrder(orderId);
    } catch (error) {
      // Payment service unreachable: we know nothing new, so push the deadline out and try later.
      sagaTimeouts.inc({ step: 'payment', decision: 'lookup_failed' });
      this.deps.logger.warn(
        { err: serializeError(error), orderId },
        'payment reconciliation lookup failed; will retry',
      );
      await this.deps.prisma.orderSaga.updateMany({
        where: { orderId, step: 'AWAITING_PAYMENT' },
        data: { deadlineAt: new Date(Date.now() + 15_000), timeoutChecks: { increment: 1 } },
      });
      return;
    }
    const outcome = await this.deps.prisma.$transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (
        !order?.saga ||
        order.saga.step !== 'AWAITING_PAYMENT' ||
        (order.status as OrderStatus) !== 'AWAITING_PAYMENT'
      )
        return undefined;
      if (!order.saga.deadlineAt || order.saga.deadlineAt > new Date()) return undefined;
      const decision = reconcilePayment(lookup, order.saga.paymentAttempts, this.deps.maxPaymentAttempts);
      sagaTimeouts.inc({ step: 'payment', decision: decision.action });
      this.deps.logger.warn(
        { orderId, lookup: lookup.status, decision: decision.action },
        'payment step timed out; reconciling',
      );
      await tx.orderSaga.update({ where: { orderId }, data: { timeoutChecks: { increment: 1 } } });
      switch (decision.action) {
        case 'confirm':
          return this.confirm(tx, order, decision.paymentId);
        case 'cancel':
          return this.cancel(tx, order, 'payment_failed', 'payment failed (found during reconciliation)');
        case 'retry_authorization':
          // Payment-service deduplicates by order ID, so a re-request can never double-charge.
          await this.requestPayment(tx, order, order.saga.paymentAttempts + 1);
          return undefined;
        case 'requires_review':
          return this.requireReview(tx, order, decision.reason);
      }
    });
    this.deps.onEventsCommitted();
    if (outcome) recordSagaOutcome(outcome.outcome, outcome.reason, outcome.startedAt);
  }
}
