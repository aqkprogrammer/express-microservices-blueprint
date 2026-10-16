import { createHash } from 'node:crypto';

export const ORDER_STATUSES = [
  'PENDING',
  'AWAITING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'REQUIRES_REVIEW',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SAGA_STEPS = [
  'AWAITING_INVENTORY',
  'AWAITING_PAYMENT',
  'COMPLETED',
  'COMPENSATED',
  'REQUIRES_REVIEW',
] as const;
export type SagaStep = (typeof SAGA_STEPS)[number];

/**
 * Allowed order status transitions. Anything not listed is rejected, which
 * makes duplicate or out-of-order events harmless: they simply do not apply.
 *
 *   PENDING ──InventoryReserved──▶ AWAITING_PAYMENT ──PaymentAuthorized──▶ CONFIRMED
 *      │                               │       │                             │
 *      └──reservation failed/timeout──▶ CANCELLED ◀──payment failed──┘       │
 *                                      ▲       └─unknown outcome─▶ REQUIRES_REVIEW
 *                                      └──────────customer/admin cancel──────┘
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['CONFIRMED', 'CANCELLED', 'REQUIRES_REVIEW'],
  CONFIRMED: ['CANCELLED', 'REQUIRES_REVIEW'],
  REQUIRES_REVIEW: ['CONFIRMED', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const isTerminal = (status: OrderStatus) => status === 'CANCELLED';

/** Customers may cancel until the order is cancelled; after confirmation this triggers a refund. */
export function canCustomerCancel(status: OrderStatus): boolean {
  return status === 'PENDING' || status === 'AWAITING_PAYMENT' || status === 'CONFIRMED';
}

export function canAdminCancel(status: OrderStatus): boolean {
  return status !== 'CANCELLED';
}

export interface PricedLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
}

export function totalCents(lines: PricedLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
}

/** Merges repeated products so each order line is unique per product. */
export function mergeRequestedLines(lines: { productId: string; quantity: number }[]) {
  const merged = new Map<string, number>();
  for (const line of lines) merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.quantity);
  return [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

/** Stable hash of the semantically relevant request fields for idempotency-key reuse detection. */
export function requestFingerprint(input: {
  lines: { productId: string; quantity: number }[];
  paymentMethodToken: string;
}) {
  const canonical = {
    lines: mergeRequestedLines(input.lines).sort((a, b) => a.productId.localeCompare(b.productId)),
    paymentMethodToken: input.paymentMethodToken,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type PaymentLookup =
  | { status: 'AUTHORIZED' | 'CAPTURED'; paymentId: string }
  | { status: 'FAILED'; paymentId: string }
  | { status: 'PENDING' | 'NOT_FOUND' | 'VOIDED' | 'REFUNDED'; paymentId?: string };

export type ReconciliationDecision =
  | { action: 'confirm'; paymentId: string }
  | { action: 'cancel' }
  | { action: 'retry_authorization' }
  | { action: 'requires_review'; reason: string };

/**
 * Decides what to do when the payment step times out. A timeout is NOT treated
 * as a failure: the orchestrator asks the payment service for the actual
 * outcome and only re-requests authorization (idempotent by order ID) or
 * escalates to manual review when the outcome is still unknown.
 */
export function reconcilePayment(
  lookup: PaymentLookup,
  attempts: number,
  maxAttempts: number,
): ReconciliationDecision {
  switch (lookup.status) {
    case 'AUTHORIZED':
    case 'CAPTURED':
      return { action: 'confirm', paymentId: lookup.paymentId };
    case 'FAILED':
      return { action: 'cancel' };
    case 'VOIDED':
    case 'REFUNDED':
      return {
        action: 'requires_review',
        reason: `payment is ${lookup.status.toLowerCase()} but order is awaiting payment`,
      };
    case 'PENDING':
    case 'NOT_FOUND':
      return attempts < maxAttempts
        ? { action: 'retry_authorization' }
        : {
            action: 'requires_review',
            reason: `payment outcome unknown after ${attempts} authorization attempts`,
          };
  }
}
