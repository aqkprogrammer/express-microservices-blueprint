/**
 * LOCAL PAYMENT PROVIDER SIMULATOR — for development and tests only.
 *
 * It mimics the behaviours a real provider integration must cope with,
 * selected by the simulated method token:
 *   sim_card_approved      → approved
 *   sim_card_declined      → declined (definitive failure)
 *   sim_insufficient_funds → declined with insufficient_funds
 *   sim_provider_timeout   → the call times out (outcome unknown); a later
 *                            status query reports it was in fact approved
 *   sim_transient_error    → provider unavailable for the first two attempts,
 *                            then approved (exercises message retries)
 *
 * A real integration would replace this class with a provider SDK client that
 * sends an idempotency key (the payment ID), and would receive asynchronous
 * results through signed webhooks — see docs/security/payments.md.
 */
export type AuthorizationResult =
  | { outcome: 'approved'; providerReference: string }
  | { outcome: 'declined'; reason: 'declined' | 'insufficient_funds' };

export class ProviderTimeoutError extends Error {
  constructor() {
    super('Payment provider did not respond in time (outcome unknown)');
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderUnavailableError extends Error {
  constructor() {
    super('Payment provider temporarily unavailable');
    this.name = 'ProviderUnavailableError';
  }
}

export interface ProviderSimulatorOptions {
  latencyMs: number;
  timeoutResolvesAfterMs: number;
  now?: () => number;
}

export class PaymentProviderSimulator {
  private readonly now: () => number;

  constructor(private readonly options: ProviderSimulatorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** `attempt` is 1-based; the provider deduplicates by `paymentId` like a real idempotency key. */
  async authorize(request: {
    paymentId: string;
    token: string;
    amountCents: number;
    attempt: number;
  }): Promise<AuthorizationResult> {
    await this.delay();
    switch (request.token) {
      case 'sim_card_approved':
        return { outcome: 'approved', providerReference: reference(request.paymentId) };
      case 'sim_card_declined':
        return { outcome: 'declined', reason: 'declined' };
      case 'sim_insufficient_funds':
        return { outcome: 'declined', reason: 'insufficient_funds' };
      case 'sim_provider_timeout':
        throw new ProviderTimeoutError();
      case 'sim_transient_error':
        if (request.attempt <= 2) throw new ProviderUnavailableError();
        return { outcome: 'approved', providerReference: reference(request.paymentId) };
      default:
        return { outcome: 'declined', reason: 'declined' };
    }
  }

  /**
   * Status query used by reconciliation. For the timeout scenario the provider
   * eventually reports the authorization as approved — demonstrating why a
   * timeout must never be treated as a failure.
   */
  async getAuthorizationStatus(request: {
    paymentId: string;
    token: string;
    firstAttemptAt: Date;
  }): Promise<AuthorizationResult | 'unknown'> {
    await this.delay();
    if (request.token === 'sim_provider_timeout') {
      return this.now() - request.firstAttemptAt.getTime() >= this.options.timeoutResolvesAfterMs
        ? { outcome: 'approved', providerReference: reference(request.paymentId) }
        : 'unknown';
    }
    if (request.token === 'sim_transient_error') return 'unknown';
    return this.authorize({ ...request, amountCents: 0, attempt: 99 });
  }

  async capture(paymentId: string): Promise<string> {
    await this.delay();
    return `sim_cap_${paymentId.slice(0, 8)}`;
  }

  async voidAuthorization(paymentId: string): Promise<string> {
    await this.delay();
    return `sim_void_${paymentId.slice(0, 8)}`;
  }

  async refund(paymentId: string, amountCents: number): Promise<string> {
    await this.delay();
    return `sim_ref_${paymentId.slice(0, 8)}_${amountCents}`;
  }

  private async delay(): Promise<void> {
    if (this.options.latencyMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
  }
}

const reference = (paymentId: string) => `sim_auth_${paymentId.replaceAll('-', '').slice(0, 16)}`;
