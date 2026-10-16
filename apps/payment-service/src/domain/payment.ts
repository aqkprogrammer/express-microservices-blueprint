export const PAYMENT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'VOIDED',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Allowed payment transitions; the service refuses anything else. */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ['PROCESSING', 'VOIDED'],
  PROCESSING: ['PROCESSING', 'AUTHORIZED', 'FAILED', 'VOIDED'],
  AUTHORIZED: ['CAPTURED', 'VOIDED'],
  CAPTURED: ['REFUNDED'],
  FAILED: [],
  VOIDED: [],
  REFUNDED: [],
};

export const canTransition = (from: PaymentStatus, to: PaymentStatus) => TRANSITIONS[from].includes(to);

export type CancellationCompensation = 'void' | 'refund' | 'flag_cancel' | 'tombstone' | 'none';

/** Compensation for OrderCancelled given the current payment state (undefined = no payment yet). */
export function compensationFor(status: PaymentStatus | undefined): CancellationCompensation {
  switch (status) {
    case undefined:
      return 'tombstone';
    case 'PENDING':
    case 'PROCESSING':
      return 'flag_cancel';
    case 'AUTHORIZED':
      return 'void';
    case 'CAPTURED':
      return 'refund';
    default:
      return 'none';
  }
}

export type AuthorizationRequestAction = 'authorize' | 'replay_authorized' | 'replay_failed' | 'ignore';

/**
 * Re-requests from the saga (after a timeout) must never double-charge:
 * a finished payment replays its outcome instead of calling the provider again.
 */
export function authorizationRequestAction(
  status: PaymentStatus | undefined,
  cancelRequested: boolean,
): AuthorizationRequestAction {
  if (cancelRequested) return 'ignore';
  switch (status) {
    case undefined:
    case 'PENDING':
    case 'PROCESSING':
      return 'authorize';
    case 'AUTHORIZED':
    case 'CAPTURED':
      return 'replay_authorized';
    case 'FAILED':
      return 'replay_failed';
    default:
      return 'ignore';
  }
}
