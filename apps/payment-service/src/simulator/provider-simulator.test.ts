import { describe, expect, it } from 'vitest';
import {
  PaymentProviderSimulator,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from './provider-simulator.js';

const id = '7b0c1b38-9a8e-4d55-8f3f-1a2b3c4d5e6f';

describe('PaymentProviderSimulator', () => {
  const simulator = new PaymentProviderSimulator({ latencyMs: 0, timeoutResolvesAfterMs: 1_000 });

  it('approves and declines according to the simulated token', async () => {
    await expect(
      simulator.authorize({ paymentId: id, token: 'sim_card_approved', amountCents: 1, attempt: 1 }),
    ).resolves.toMatchObject({ outcome: 'approved' });
    await expect(
      simulator.authorize({ paymentId: id, token: 'sim_card_declined', amountCents: 1, attempt: 1 }),
    ).resolves.toEqual({ outcome: 'declined', reason: 'declined' });
    await expect(
      simulator.authorize({ paymentId: id, token: 'sim_insufficient_funds', amountCents: 1, attempt: 1 }),
    ).resolves.toEqual({
      outcome: 'declined',
      reason: 'insufficient_funds',
    });
  });

  it('fails transiently twice, then approves', async () => {
    await expect(
      simulator.authorize({ paymentId: id, token: 'sim_transient_error', amountCents: 1, attempt: 1 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      simulator.authorize({ paymentId: id, token: 'sim_transient_error', amountCents: 1, attempt: 2 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(
      simulator.authorize({ paymentId: id, token: 'sim_transient_error', amountCents: 1, attempt: 3 }),
    ).resolves.toMatchObject({ outcome: 'approved' });
  });

  it('times out, and reconciliation later reveals the authorization succeeded', async () => {
    let now = 0;
    const clocked = new PaymentProviderSimulator({
      latencyMs: 0,
      timeoutResolvesAfterMs: 1_000,
      now: () => now,
    });
    await expect(
      clocked.authorize({ paymentId: id, token: 'sim_provider_timeout', amountCents: 1, attempt: 1 }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    const firstAttemptAt = new Date(0);
    await expect(
      clocked.getAuthorizationStatus({ paymentId: id, token: 'sim_provider_timeout', firstAttemptAt }),
    ).resolves.toBe('unknown');
    now = 1_000;
    await expect(
      clocked.getAuthorizationStatus({ paymentId: id, token: 'sim_provider_timeout', firstAttemptAt }),
    ).resolves.toMatchObject({ outcome: 'approved' });
  });
});
