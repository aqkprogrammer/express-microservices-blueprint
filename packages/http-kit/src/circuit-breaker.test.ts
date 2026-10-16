import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  const failing = () => Promise.reject(new Error('down'));

  it('opens after consecutive failures and fails fast while open', async () => {
    let now = 0;
    const states: string[] = [];
    const breaker = new CircuitBreaker('svc', {
      failureThreshold: 2,
      openDurationMs: 1_000,
      now: () => now,
      onStateChange: (state) => states.push(state),
    });
    await expect(breaker.execute(failing)).rejects.toThrow('down');
    await expect(breaker.execute(failing)).rejects.toThrow('down');
    expect(breaker.currentState).toBe('open');
    await expect(breaker.execute(() => Promise.resolve(1))).rejects.toBeInstanceOf(CircuitOpenError);

    now = 1_000;
    expect(breaker.currentState).toBe('half_open');
    await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
    expect(states).toEqual(['open', 'half_open', 'closed']);
  });

  it('re-opens when the half-open trial fails', async () => {
    let now = 0;
    const breaker = new CircuitBreaker('svc', { failureThreshold: 1, openDurationMs: 10, now: () => now });
    await expect(breaker.execute(failing)).rejects.toThrow();
    now = 10;
    await expect(breaker.execute(failing)).rejects.toThrow('down');
    expect(breaker.currentState).toBe('open');
  });

  it('ignores errors the caller classifies as non-failures', async () => {
    const breaker = new CircuitBreaker('svc', { failureThreshold: 1 });
    await expect(breaker.execute(failing, () => false)).rejects.toThrow();
    expect(breaker.currentState).toBe('closed');
  });
});
