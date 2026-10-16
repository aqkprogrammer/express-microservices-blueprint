/**
 * Pure reservation rules. Persistence and concurrency control live in the
 * repository; this module decides *what* should happen for each message.
 */
export const RESERVATION_STATUSES = [
  'RESERVED',
  'COMMITTED',
  'RELEASED',
  'EXPIRED',
  'REJECTED',
  'CANCELLED',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export interface RequestedLine {
  productId: string;
  quantity: number;
}

/**
 * Merges duplicate products and sorts by product ID. Locking rows in a
 * consistent order prevents deadlocks between concurrent reservations.
 */
export function normalizeLines(lines: RequestedLine[]): RequestedLine[] {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.quantity);
  return [...totals.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

export type CancellationAction = 'tombstone' | 'release_reserved' | 'restock_committed' | 'none';

/** What OrderCancelled does, given the current reservation status (undefined = not seen yet). */
export function cancellationAction(status: ReservationStatus | undefined): CancellationAction {
  switch (status) {
    case undefined:
      return 'tombstone';
    case 'RESERVED':
      return 'release_reserved';
    case 'COMMITTED':
      return 'restock_committed';
    default:
      return 'none';
  }
}

export type ConfirmationAction =
  'commit_reserved' | 'reserve_and_commit' | 'already_committed' | 'cannot_commit';

/** What OrderConfirmed does. An expired reservation is retried against current stock. */
export function confirmationAction(status: ReservationStatus | undefined): ConfirmationAction {
  switch (status) {
    case 'RESERVED':
      return 'commit_reserved';
    case 'EXPIRED':
      return 'reserve_and_commit';
    case 'COMMITTED':
      return 'already_committed';
    default:
      return 'cannot_commit';
  }
}

/** A reservation request is ignored if this order already has any reservation record. */
export const shouldAttemptReservation = (existing: ReservationStatus | undefined) => existing === undefined;
