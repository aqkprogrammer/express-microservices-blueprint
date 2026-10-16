export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before allowing a trial request. */
  openDurationMs?: number;
  now?: () => number;
  onStateChange?: (state: CircuitState) => void;
}

export class CircuitOpenError extends Error {
  constructor(public readonly target: string) {
    super(`Circuit for ${target} is open`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Minimal consecutive-failure circuit breaker. While open, calls fail
 * immediately instead of piling up on a struggling dependency; after
 * `openDurationMs` one trial call is let through (half-open).
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly now: () => number;

  constructor(
    private readonly target: string,
    private readonly options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openDurationMs = options.openDurationMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.openDurationMs) return 'half_open';
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>, isFailure: (error: unknown) => boolean = () => true): Promise<T> {
    const state = this.currentState;
    if (state === 'open') throw new CircuitOpenError(this.target);
    if (state === 'half_open') {
      if (this.trialInFlight) throw new CircuitOpenError(this.target);
      this.trialInFlight = true;
      this.transition('half_open');
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (isFailure(error)) this.onFailure();
      else this.onSuccess();
      throw error;
    } finally {
      if (state === 'half_open') this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state !== 'closed') this.transition('closed');
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  private transition(state: CircuitState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
