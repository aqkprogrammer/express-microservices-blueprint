import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  canCustomerCancel,
  canTransition,
  mergeRequestedLines,
  reconcilePayment,
  requestFingerprint,
  totalCents,
} from './order.js';

describe('order state machine', () => {
  it('follows the happy path', () => {
    expect(canTransition('PENDING', 'AWAITING_PAYMENT')).toBe(true);
    expect(canTransition('AWAITING_PAYMENT', 'CONFIRMED')).toBe(true);
  });

  it('rejects skipping steps and leaving CANCELLED', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(false);
    for (const status of ORDER_STATUSES) expect(canTransition('CANCELLED', status)).toBe(false);
  });

  it('allows compensation from every non-terminal state', () => {
    for (const status of ['PENDING', 'AWAITING_PAYMENT', 'CONFIRMED', 'REQUIRES_REVIEW'] as const) {
      expect(canTransition(status, 'CANCELLED')).toBe(true);
    }
  });

  it('lets customers cancel until the order is cancelled or under review', () => {
    expect(canCustomerCancel('CONFIRMED')).toBe(true);
    expect(canCustomerCancel('REQUIRES_REVIEW')).toBe(false);
    expect(canCustomerCancel('CANCELLED')).toBe(false);
  });
});

describe('pricing and idempotency helpers', () => {
  it('computes totals in integer cents', () => {
    expect(
      totalCents([
        { productId: 'a', sku: 'A', name: 'A', quantity: 3, unitPriceCents: 1_999 },
        { productId: 'b', sku: 'B', name: 'B', quantity: 1, unitPriceCents: 1 },
      ]),
    ).toBe(5_998);
  });

  it('merges duplicate lines', () => {
    expect(
      mergeRequestedLines([
        { productId: 'a', quantity: 1 },
        { productId: 'a', quantity: 2 },
      ]),
    ).toEqual([{ productId: 'a', quantity: 3 }]);
  });

  it('fingerprints requests independent of line order', () => {
    const a = requestFingerprint({
      lines: [
        { productId: 'x', quantity: 1 },
        { productId: 'y', quantity: 2 },
      ],
      paymentMethodToken: 'sim_card_approved',
    });
    const b = requestFingerprint({
      lines: [
        { productId: 'y', quantity: 2 },
        { productId: 'x', quantity: 1 },
      ],
      paymentMethodToken: 'sim_card_approved',
    });
    const c = requestFingerprint({
      lines: [{ productId: 'x', quantity: 1 }],
      paymentMethodToken: 'sim_card_approved',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('payment reconciliation after a timeout', () => {
  it('confirms when the payment was actually authorized', () => {
    expect(reconcilePayment({ status: 'AUTHORIZED', paymentId: 'p' }, 1, 3)).toEqual({
      action: 'confirm',
      paymentId: 'p',
    });
  });

  it('cancels only on a definitive failure', () => {
    expect(reconcilePayment({ status: 'FAILED', paymentId: 'p' }, 1, 3)).toEqual({ action: 'cancel' });
  });

  it('re-requests authorization while attempts remain, then escalates instead of assuming failure', () => {
    expect(reconcilePayment({ status: 'PENDING' }, 1, 3).action).toBe('retry_authorization');
    expect(reconcilePayment({ status: 'NOT_FOUND' }, 2, 3).action).toBe('retry_authorization');
    expect(reconcilePayment({ status: 'PENDING' }, 3, 3)).toMatchObject({ action: 'requires_review' });
  });
});
