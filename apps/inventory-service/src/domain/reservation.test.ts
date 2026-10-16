import { describe, expect, it } from 'vitest';
import {
  cancellationAction,
  confirmationAction,
  normalizeLines,
  shouldAttemptReservation,
} from './reservation.js';

describe('reservation rules', () => {
  it('merges duplicate products and orders lines deterministically', () => {
    expect(
      normalizeLines([
        { productId: 'b', quantity: 1 },
        { productId: 'a', quantity: 2 },
        { productId: 'b', quantity: 3 },
      ]),
    ).toEqual([
      { productId: 'a', quantity: 2 },
      { productId: 'b', quantity: 4 },
    ]);
  });

  it('writes a tombstone when cancellation arrives before the reservation', () => {
    expect(cancellationAction(undefined)).toBe('tombstone');
    expect(shouldAttemptReservation('CANCELLED')).toBe(false);
  });

  it('compensates according to reservation state', () => {
    expect(cancellationAction('RESERVED')).toBe('release_reserved');
    expect(cancellationAction('COMMITTED')).toBe('restock_committed');
    for (const status of ['RELEASED', 'EXPIRED', 'REJECTED', 'CANCELLED'] as const) {
      expect(cancellationAction(status)).toBe('none');
    }
  });

  it('commits, re-reserves expired stock, or refuses', () => {
    expect(confirmationAction('RESERVED')).toBe('commit_reserved');
    expect(confirmationAction('EXPIRED')).toBe('reserve_and_commit');
    expect(confirmationAction('COMMITTED')).toBe('already_committed');
    expect(confirmationAction('REJECTED')).toBe('cannot_commit');
    expect(confirmationAction(undefined)).toBe('cannot_commit');
  });

  it('only reserves once per order', () => {
    expect(shouldAttemptReservation(undefined)).toBe(true);
    expect(shouldAttemptReservation('RESERVED')).toBe(false);
  });
});
