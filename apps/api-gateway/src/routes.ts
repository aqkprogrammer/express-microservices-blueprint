import type { GatewayConfig } from './config.js';

export type UpstreamName =
  'auth' | 'user' | 'product' | 'inventory' | 'order' | 'payment' | 'notification' | 'audit';

export interface RouteDefinition {
  /** Public path prefix; matched on whole segments. */
  prefix: string;
  upstream: UpstreamName;
  /** Bounded metric label for the route. */
  label: string;
  strictRateLimit?: boolean;
}

/**
 * The complete public surface. Anything not listed — including every
 * `/internal/*`, `/metrics`, `/health/*` and `/admin/*` path of the services —
 * is unreachable through the gateway. Order matters: more specific first.
 */
export const ROUTES: RouteDefinition[] = [
  { prefix: '/.well-known/jwks.json', upstream: 'auth', label: '/.well-known/jwks.json' },
  { prefix: '/api/v1/auth/login', upstream: 'auth', label: '/api/v1/auth/login', strictRateLimit: true },
  {
    prefix: '/api/v1/auth/register',
    upstream: 'auth',
    label: '/api/v1/auth/register',
    strictRateLimit: true,
  },
  { prefix: '/api/v1/auth/refresh', upstream: 'auth', label: '/api/v1/auth/refresh', strictRateLimit: true },
  {
    prefix: '/api/v1/auth/password-reset',
    upstream: 'auth',
    label: '/api/v1/auth/password-reset/*',
    strictRateLimit: true,
  },
  { prefix: '/api/v1/auth', upstream: 'auth', label: '/api/v1/auth/*' },
  { prefix: '/api/v1/users', upstream: 'user', label: '/api/v1/users/*' },
  { prefix: '/api/v1/products', upstream: 'product', label: '/api/v1/products/*' },
  { prefix: '/api/v1/inventory', upstream: 'inventory', label: '/api/v1/inventory/*' },
  { prefix: '/api/v1/orders', upstream: 'order', label: '/api/v1/orders/*' },
  { prefix: '/api/v1/payments', upstream: 'payment', label: '/api/v1/payments/*' },
  { prefix: '/api/v1/notifications', upstream: 'notification', label: '/api/v1/notifications/*' },
  { prefix: '/api/v1/audit-events', upstream: 'audit', label: '/api/v1/audit-events' },
];

export function upstreamUrls(config: GatewayConfig): Record<UpstreamName, string> {
  return {
    auth: config.AUTH_SERVICE_URL,
    user: config.USER_SERVICE_URL,
    product: config.PRODUCT_SERVICE_URL,
    inventory: config.INVENTORY_SERVICE_URL,
    order: config.ORDER_SERVICE_URL,
    payment: config.PAYMENT_SERVICE_URL,
    notification: config.NOTIFICATION_SERVICE_URL,
    audit: config.AUDIT_SERVICE_URL,
  };
}

export class UnsafePathError extends Error {}

/**
 * Normalises the request path before matching so `..` segments, duplicate
 * slashes or encoded separators cannot smuggle a request onto an internal
 * upstream path (e.g. `/api/v1/orders/../../internal/...`).
 */
export function normalizePath(rawUrl: string): { pathname: string; search: string } {
  const [rawPath = '/'] = rawUrl.split('?');
  if (/%2e|%2f|%5c|\\/i.test(rawPath)) throw new UnsafePathError('Encoded path separators are not allowed');
  if (rawPath.split('/').some((segment) => segment === '..' || segment === '.'))
    throw new UnsafePathError('Relative path segments are not allowed');
  const url = new URL(rawUrl, 'http://gateway.invalid');
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  return { pathname, search: url.search };
}

export function matchRoute(pathname: string): RouteDefinition | undefined {
  return ROUTES.find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}
