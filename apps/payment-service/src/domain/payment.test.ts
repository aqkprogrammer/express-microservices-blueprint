import { describe, expect, it } from 'vitest';
import { authorizationRequestAction, canTransition, compensationFor } from './payment.js';

describe('payment rules', () => {
  it('enforces the payment lifecycle', () => {
    expect(canTransition('AUTHORIZED', 'CAPTURED')).toBe(true);
    expect(canTransition('CAPTURED', 'REFUNDED')).toBe(true);
    expect(canTransition('FAILED', 'AUTHORIZED')).toBe(false);
    expect(canTransition('PENDING', 'CAPTURED')).toBe(false);
  });

  it('compensates cancellations according to state', () => {
    expect(compensationFor('AUTHORIZED')).toBe('void');
    expect(compensationFor('CAPTURED')).toBe('refund');
    expect(compensationFor('PROCESSING')).toBe('flag_cancel');
    expect(compensationFor(undefined)).toBe('tombstone');
    expect(compensationFor('REFUNDED')).toBe('none');
  });

  it('never re-authorizes a finished payment', () => {
    expect(authorizationRequestAction(undefined, false)).toBe('authorize');
    expect(authorizationRequestAction('PROCESSING', false)).toBe('authorize');
    expect(authorizationRequestAction('AUTHORIZED', false)).toBe('replay_authorized');
    expect(authorizationRequestAction('FAILED', false)).toBe('replay_failed');
    expect(authorizationRequestAction('PENDING', true)).toBe('ignore');
    expect(authorizationRequestAction('VOIDED', false)).toBe('ignore');
  });
});
