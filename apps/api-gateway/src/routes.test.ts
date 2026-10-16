import { describe, expect, it } from 'vitest';
import { UnsafePathError, matchRoute, normalizePath } from './routes.js';

describe('gateway routing', () => {
  it('routes public prefixes on whole path segments', () => {
    expect(matchRoute('/api/v1/orders')?.upstream).toBe('order');
    expect(matchRoute('/api/v1/orders/123/cancel')?.upstream).toBe('order');
    expect(matchRoute('/api/v1/ordersX')).toBeUndefined();
  });

  it('applies the strict limiter to credential endpoints only', () => {
    expect(matchRoute('/api/v1/auth/login')?.strictRateLimit).toBe(true);
    expect(matchRoute('/api/v1/auth/password-reset/confirm')?.strictRateLimit).toBe(true);
    expect(matchRoute('/api/v1/auth/me')?.strictRateLimit).toBeUndefined();
  });

  it('never exposes internal, operational or admin paths', () => {
    for (const path of [
      '/internal/v1/products',
      '/metrics',
      '/health/ready',
      '/admin/v1/dead-letters',
      '/openapi.json',
    ]) {
      expect(matchRoute(path), path).toBeUndefined();
    }
  });

  it('rejects traversal and encoded separators', () => {
    expect(() => normalizePath('/api/v1/orders/../../internal/v1/products')).toThrow(UnsafePathError);
    expect(() => normalizePath('/api/v1/orders/%2e%2e/%2e%2e/internal')).toThrow(UnsafePathError);
    expect(() => normalizePath('/api/v1/orders%2Finternal')).toThrow(UnsafePathError);
  });

  it('collapses duplicate slashes and keeps the query string', () => {
    expect(normalizePath('/api/v1//products?page=2&q=desk')).toEqual({
      pathname: '/api/v1/products',
      search: '?page=2&q=desk',
    });
  });
});
