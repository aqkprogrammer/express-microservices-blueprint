import { randomUUID } from 'node:crypto';
import type { EventPayload } from '@emb/contracts';
import { enqueueEvent, isUniqueViolation, markMessageProcessed } from '@emb/database';
import { ConflictError, NotFoundError, UnprocessableError } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { counter } from '@emb/observability';
import type { Principal } from '@emb/security';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import {
  type PaymentProviderSimulator,
  ProviderTimeoutError,
  type AuthorizationResult,
} from '../simulator/provider-simulator.js';
import { authorizationRequestAction, canTransition, compensationFor, type PaymentStatus } from './payment.js';

const PRODUCER = 'payment-service';
const TOMBSTONE_TOKEN = 'sim_none';
const paymentOperations = counter('payment_operations_total', 'Simulated payment operations by outcome', [
  'operation',
  'outcome',
]);

type Tx = Prisma.TransactionClient;
type PaymentRow = Prisma.PaymentGetPayload<object>;
const meta = (payment: { id: string }) => ({
  producer: PRODUCER,
  aggregateType: 'payment',
  aggregateId: payment.id,
});

export interface PaymentDto {
  id: string;
  orderId: string;
  customerId: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  failureReason: string | null;
  capturedCents: number;
  refundedCents: number;
  authorizationAttempts: number;
  createdAt: string;
  updatedAt: string;
}

/** Response shaping: the method token and provider references stay internal. */
export const toPaymentDto = (row: PaymentRow): PaymentDto => ({
  id: row.id,
  orderId: row.orderId,
  customerId: row.customerId,
  amountCents: row.amountCents,
  currency: row.currency,
  status: row.status as PaymentStatus,
  failureReason: row.failureReason,
  capturedCents: row.capturedCents,
  refundedCents: row.refundedCents,
  authorizationAttempts: row.authorizationAttempts,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export interface PaymentServiceDeps {
  prisma: PrismaClient;
  provider: PaymentProviderSimulator;
  logger: Logger;
  reconcileAfterMs: number;
  onEventsCommitted: () => void;
}

/**
 * Payment state is the idempotency anchor: one payment per order (unique
 * order_id), and every operation checks the current status before acting, so
 * duplicate commands replay outcomes instead of repeating side effects.
 * Authorization — the slow, uncertain provider call — happens outside any
 * database transaction and its result is applied afterwards with a
 * conditional status update. The simulator's capture/void/refund calls are
 * instantaneous and run inside the transaction for brevity; a real integration
 * would give them the same record-intent → call → apply structure.
 */
export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  // ── Saga participant ───────────────────────────────────────────────────────

  async handleAuthorizationRequested(payload: EventPayload<'PaymentAuthorizationRequested'>): Promise<void> {
    const prepared = await this.deps.prisma.$transaction(async (tx) => {
      let payment = await this.lockByOrder(tx, payload.orderId);
      const action = authorizationRequestAction(
        payment?.status as PaymentStatus | undefined,
        payment?.cancelRequested ?? false,
      );
      if (action === 'ignore') return undefined;
      if (action === 'replay_authorized' && payment) {
        await enqueueEvent(tx, 'PaymentAuthorized', authorizedPayload(payment), meta(payment));
        return undefined;
      }
      if (action === 'replay_failed' && payment) {
        await enqueueEvent(tx, 'PaymentFailed', failedPayload(payment), meta(payment));
        return undefined;
      }
      if (!payment) {
        payment = await tx.payment.create({
          data: {
            id: randomUUID(),
            orderId: payload.orderId,
            customerId: payload.customerId,
            amountCents: payload.amountCents,
            currency: payload.currency,
            status: 'PENDING',
            methodToken: payload.paymentMethodToken,
          },
        });
        await this.audit(tx, payment.id, 'create', 'pending', `saga attempt ${payload.attempt}`);
      }
      const outcomeUnknown = payment.status === 'PROCESSING';
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'PROCESSING', authorizationAttempts: { increment: 1 }, lastAttemptAt: new Date() },
      });
      return { payment: updated, outcomeUnknown };
    });
    this.deps.onEventsCommitted();
    if (!prepared) return;
    // A previous attempt timed out: ask the provider what happened before trying again,
    // exactly as a real integration would (the provider may have approved it after all).
    if (prepared.outcomeUnknown && (await this.resolveFromProvider(prepared.payment))) return;
    await this.authorizeWithProvider(prepared.payment);
  }

  /** Queries the provider for an in-flight authorization. Returns true when the outcome was known and applied. */
  private async resolveFromProvider(payment: PaymentRow): Promise<boolean> {
    const firstAttempt = await this.deps.prisma.paymentEvent.findFirst({
      where: { paymentId: payment.id, action: 'authorize' },
      orderBy: { id: 'asc' },
    });
    const status = await this.deps.provider.getAuthorizationStatus({
      paymentId: payment.id,
      token: payment.methodToken,
      firstAttemptAt: firstAttempt?.createdAt ?? payment.createdAt,
    });
    if (status === 'unknown') return false;
    await this.applyAuthorizationResult(payment.id, status, 'reconcile');
    return true;
  }

  /** Calls the provider and applies the result. Transient errors propagate so the consumer retries the message. */
  private async authorizeWithProvider(payment: PaymentRow): Promise<void> {
    let result: AuthorizationResult;
    try {
      result = await this.deps.provider.authorize({
        paymentId: payment.id,
        token: payment.methodToken,
        amountCents: payment.amountCents,
        attempt: payment.authorizationAttempts,
      });
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        // Outcome unknown: leave PROCESSING. Reconciliation (and the order saga's timeout) resolves it later.
        paymentOperations.inc({ operation: 'authorize', outcome: 'timeout' });
        await this.deps.prisma.$transaction((tx) =>
          this.audit(tx, payment.id, 'authorize', 'timeout', 'provider timeout; outcome unknown'),
        );
        this.deps.logger.warn(
          { paymentId: payment.id, orderId: payment.orderId },
          'provider timeout; awaiting reconciliation',
        );
        return;
      }
      paymentOperations.inc({ operation: 'authorize', outcome: 'provider_error' });
      await this.deps.prisma.$transaction((tx) =>
        this.audit(
          tx,
          payment.id,
          'authorize',
          'provider_error',
          error instanceof Error ? error.message : 'error',
        ),
      );
      throw error;
    }
    await this.applyAuthorizationResult(payment.id, result, 'authorize');
  }

  private async applyAuthorizationResult(
    paymentId: string,
    result: AuthorizationResult,
    operation: 'authorize' | 'reconcile',
  ) {
    await this.deps.prisma.$transaction(async (tx) => {
      const payment = await this.lockById(tx, paymentId);
      if (!payment || payment.status !== 'PROCESSING') return;
      if (result.outcome === 'approved') {
        const authorized = await tx.payment.update({
          where: { id: paymentId },
          data: { status: 'AUTHORIZED', providerReference: result.providerReference, failureReason: null },
        });
        await this.audit(tx, paymentId, operation, 'authorized');
        paymentOperations.inc({ operation, outcome: 'authorized' });
        if (payment.cancelRequested) {
          // The order was cancelled while we were waiting on the provider: release the hold immediately.
          await this.voidPayment(tx, authorized, 'order cancelled during authorization');
          return;
        }
        await enqueueEvent(tx, 'PaymentAuthorized', authorizedPayload(authorized), meta(authorized));
      } else {
        const failed = await tx.payment.update({
          where: { id: paymentId },
          data: { status: 'FAILED', failureReason: result.reason },
        });
        await this.audit(tx, paymentId, operation, 'failed', result.reason);
        paymentOperations.inc({ operation, outcome: 'failed' });
        await enqueueEvent(tx, 'PaymentFailed', failedPayload(failed), meta(failed));
      }
    });
    this.deps.onEventsCommitted();
  }

  async handleOrderConfirmed(messageId: string, payload: EventPayload<'OrderConfirmed'>): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      if (!(await markMessageProcessed(tx, 'payment.order-confirmed', messageId))) return;
      const payment = await this.lockByOrder(tx, payload.orderId);
      if (!payment || payment.status !== 'AUTHORIZED') return;
      await this.capturePayment(tx, payment);
    });
    this.deps.onEventsCommitted();
  }

  async handleOrderCancelled(messageId: string, payload: EventPayload<'OrderCancelled'>): Promise<void> {
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        if (!(await markMessageProcessed(tx, 'payment.order-cancelled', messageId))) return;
        const payment = await this.lockByOrder(tx, payload.orderId);
        const action = compensationFor(payment?.status as PaymentStatus | undefined);
        switch (action) {
          case 'tombstone': {
            // Cancellation overtook the authorization request: record it so a late request is ignored.
            const tombstone = await tx.payment.create({
              data: {
                id: randomUUID(),
                orderId: payload.orderId,
                customerId: payload.customerId,
                amountCents: 0,
                currency: 'USD',
                status: 'VOIDED',
                methodToken: TOMBSTONE_TOKEN,
                cancelRequested: true,
                failureReason: 'order cancelled before payment was requested',
              },
            });
            await this.audit(tx, tombstone.id, 'cancel', 'tombstone');
            return;
          }
          case 'flag_cancel':
            if (!payment) return;
            if (payment.status === 'PENDING') {
              await this.voidPayment(tx, payment, `order cancelled: ${payload.reason}`);
            } else {
              await tx.payment.update({ where: { id: payment.id }, data: { cancelRequested: true } });
              await this.audit(
                tx,
                payment.id,
                'cancel',
                'flagged',
                'void after in-flight authorization completes',
              );
            }
            return;
          case 'void':
            if (payment) await this.voidPayment(tx, payment, `order cancelled: ${payload.reason}`);
            return;
          case 'refund':
            if (payment)
              await this.refundPayment(
                tx,
                payment,
                payment.capturedCents - payment.refundedCents,
                `order cancelled: ${payload.reason}`,
              );
            return;
          case 'none':
            return;
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    this.deps.onEventsCommitted();
  }

  /** Scheduled: resolve payments stuck in PROCESSING by asking the provider for the real outcome. */
  async reconcile(limit = 50): Promise<number> {
    const stuck = await this.deps.prisma.payment.findMany({
      where: {
        status: 'PROCESSING',
        lastAttemptAt: { lt: new Date(Date.now() - this.deps.reconcileAfterMs) },
      },
      take: limit,
      orderBy: { lastAttemptAt: 'asc' },
    });
    let resolved = 0;
    for (const payment of stuck) {
      if (await this.resolveFromProvider(payment)) resolved += 1;
    }
    if (stuck.length > 0)
      this.deps.logger.info({ checked: stuck.length, resolved }, 'payment reconciliation run');
    return resolved;
  }

  // ── REST API ───────────────────────────────────────────────────────────────

  /** Back-office payment intent for an order without a payment yet; authorizes synchronously. */
  async createIntent(input: {
    orderId: string;
    customerId: string;
    amountCents: number;
    currency: string;
    paymentMethodToken: string;
  }): Promise<PaymentDto> {
    let payment: PaymentRow;
    try {
      payment = await this.deps.prisma.$transaction(async (tx) => {
        const created = await tx.payment.create({
          data: {
            id: randomUUID(),
            orderId: input.orderId,
            customerId: input.customerId,
            amountCents: input.amountCents,
            currency: input.currency,
            status: 'PROCESSING',
            methodToken: input.paymentMethodToken,
            authorizationAttempts: 1,
            lastAttemptAt: new Date(),
          },
        });
        await this.audit(tx, created.id, 'create', 'processing', 'payment intent');
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError('A payment already exists for this order', 'payment_exists');
      throw error;
    }
    try {
      await this.authorizeWithProvider(payment);
    } catch {
      // Transient provider failure: the intent stays PROCESSING and reconciliation picks it up.
    }
    return toPaymentDto(await this.deps.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }));
  }

  async get(paymentId: string, auth: Principal): Promise<PaymentDto> {
    const payment = await this.deps.prisma.payment.findUnique({ where: { id: paymentId } });
    if (
      !payment ||
      isTombstone(payment) ||
      (payment.customerId !== auth.userId && !auth.roles.includes('admin'))
    ) {
      throw new NotFoundError('Payment not found');
    }
    return toPaymentDto(payment);
  }

  async findByOrder(orderId: string): Promise<PaymentDto> {
    const payment = await this.deps.prisma.payment.findUnique({ where: { orderId } });
    if (!payment) throw new NotFoundError('Payment not found');
    return toPaymentDto(payment);
  }

  async listForOrder(orderId: string, auth: Principal): Promise<PaymentDto[]> {
    const payment = await this.deps.prisma.payment.findUnique({ where: { orderId } });
    if (
      !payment ||
      isTombstone(payment) ||
      (payment.customerId !== auth.userId && !auth.roles.includes('admin'))
    )
      return [];
    return [toPaymentDto(payment)];
  }

  async capture(paymentId: string): Promise<PaymentDto> {
    const result = await this.deps.prisma.$transaction(async (tx) => {
      const payment = await this.lockById(tx, paymentId);
      if (!payment) throw new NotFoundError('Payment not found');
      if (payment.status === 'CAPTURED') return payment;
      if (!canTransition(payment.status as PaymentStatus, 'CAPTURED')) {
        throw new ConflictError(
          `Payment in status ${payment.status} cannot be captured`,
          'invalid_payment_state',
        );
      }
      return this.capturePayment(tx, payment);
    });
    this.deps.onEventsCommitted();
    return toPaymentDto(result);
  }

  async refund(paymentId: string, amountCents: number | undefined, reason: string): Promise<PaymentDto> {
    const result = await this.deps.prisma.$transaction(async (tx) => {
      const payment = await this.lockById(tx, paymentId);
      if (!payment) throw new NotFoundError('Payment not found');
      if (payment.status !== 'CAPTURED')
        throw new ConflictError(
          `Payment in status ${payment.status} cannot be refunded`,
          'invalid_payment_state',
        );
      const refundable = payment.capturedCents - payment.refundedCents;
      const amount = amountCents ?? refundable;
      if (amount <= 0 || amount > refundable)
        throw new UnprocessableError(
          `Refund amount must be between 1 and ${refundable}`,
          'invalid_refund_amount',
        );
      return this.refundPayment(tx, payment, amount, reason);
    });
    this.deps.onEventsCommitted();
    return toPaymentDto(result);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async capturePayment(tx: Tx, payment: PaymentRow): Promise<PaymentRow> {
    await this.deps.provider.capture(payment.id);
    const captured = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'CAPTURED', capturedCents: payment.amountCents },
    });
    await this.audit(tx, payment.id, 'capture', 'captured');
    await enqueueEvent(
      tx,
      'PaymentCaptured',
      { paymentId: payment.id, orderId: payment.orderId, amountCents: payment.amountCents },
      meta(payment),
    );
    paymentOperations.inc({ operation: 'capture', outcome: 'captured' });
    return captured;
  }

  private async voidPayment(tx: Tx, payment: PaymentRow, reason: string): Promise<PaymentRow> {
    if (payment.status === 'AUTHORIZED') await this.deps.provider.voidAuthorization(payment.id);
    const voided = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'VOIDED', cancelRequested: true },
    });
    await this.audit(tx, payment.id, 'void', 'voided', reason);
    await enqueueEvent(
      tx,
      'PaymentVoided',
      { paymentId: payment.id, orderId: payment.orderId },
      meta(payment),
    );
    paymentOperations.inc({ operation: 'void', outcome: 'voided' });
    return voided;
  }

  private async refundPayment(
    tx: Tx,
    payment: PaymentRow,
    amountCents: number,
    reason: string,
  ): Promise<PaymentRow> {
    await this.deps.provider.refund(payment.id, amountCents);
    const refundedCents = payment.refundedCents + amountCents;
    const refunded = await tx.payment.update({
      where: { id: payment.id },
      // Partial refunds keep the payment CAPTURED; a full refund moves it to REFUNDED.
      data: { refundedCents, status: refundedCents === payment.capturedCents ? 'REFUNDED' : 'CAPTURED' },
    });
    await this.audit(tx, payment.id, 'refund', 'refunded', `${amountCents} cents: ${reason}`);
    await enqueueEvent(
      tx,
      'PaymentRefunded',
      {
        paymentId: payment.id,
        orderId: payment.orderId,
        customerId: payment.customerId,
        amountCents,
        currency: payment.currency,
      },
      meta(payment),
    );
    paymentOperations.inc({ operation: 'refund', outcome: 'refunded' });
    return refunded;
  }

  private async lockByOrder(tx: Tx, orderId: string): Promise<PaymentRow | null> {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id::text FROM payments WHERE order_id = ${orderId}::uuid FOR UPDATE`;
    return rows[0] ? tx.payment.findUnique({ where: { id: rows[0].id } }) : null;
  }

  private async lockById(tx: Tx, paymentId: string): Promise<PaymentRow | null> {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id::text FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    return rows[0] ? tx.payment.findUnique({ where: { id: paymentId } }) : null;
  }

  private async audit(
    tx: Tx,
    paymentId: string,
    action: string,
    outcome: string,
    detail?: string,
  ): Promise<void> {
    await tx.paymentEvent.create({ data: { paymentId, action, outcome, detail: detail ?? null } });
  }
}

/** Bookkeeping rows for cancellations that arrived before any payment was requested; never shown to clients. */
const isTombstone = (payment: PaymentRow) => payment.methodToken === TOMBSTONE_TOKEN;

const authorizedPayload = (payment: PaymentRow) => ({
  paymentId: payment.id,
  orderId: payment.orderId,
  amountCents: payment.amountCents,
  currency: payment.currency,
});

const failedPayload = (payment: PaymentRow): EventPayload<'PaymentFailed'> => ({
  paymentId: payment.id,
  orderId: payment.orderId,
  reason: payment.failureReason === 'insufficient_funds' ? 'insufficient_funds' : 'declined',
});
