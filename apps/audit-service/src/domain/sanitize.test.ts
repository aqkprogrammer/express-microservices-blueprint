import { describe, expect, it } from 'vitest';
import { actorOf, categorize, sanitizeDetails } from './sanitize.js';

describe('audit sanitisation', () => {
  it('keeps allow-listed identifiers and drops personal data', () => {
    const details = sanitizeDetails({
      userId: 'u-1',
      email: 'ada@example.com',
      displayName: 'Ada',
      roles: ['customer'],
      registeredAt: '2026-01-01T00:00:00Z',
    });
    expect(details).toEqual({ userId: 'u-1', roles: ['customer'] });
  });

  it('never stores secrets even in allowed fields', () => {
    expect(sanitizeDetails({ reason: 'Bearer eyJhbGciOiJFUzI1NiJ9.abc.def' })).toEqual({});
    expect(sanitizeDetails({ reason: 'password reset' })).toEqual({});
    expect(sanitizeDetails({ resetUrl: 'https://x/?token=abc', data: { resetUrl: 'x' } })).toEqual({});
  });

  it('categorises and finds actors', () => {
    expect(categorize('LoginFailed')).toBe('security');
    expect(categorize('OrderConfirmed')).toBe('business');
    expect(actorOf({ changedBy: 'admin-1', userId: 'u-1' })).toBe('admin-1');
  });
});
