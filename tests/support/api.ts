import { randomUUID } from 'node:crypto';

/** Helpers for tests that run against the Docker Compose stack through the public gateway. */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
export const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:3009';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.test';
export const ADMIN_PASSWORD = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? 'local-dev-admin-password';

export const PRODUCTS = {
  keyboard: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001',
  mouse: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2002',
  headphones: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2004',
  webcam: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2006',
  stand: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2007',
} as const;

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; baseUrl?: string } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${options.baseUrl ?? BASE_URL}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON (e.g. HTML docs)
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

export async function poll<T>(
  probe: () => Promise<T | undefined | false>,
  description: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: last });
}

export interface Session {
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}

export async function registerCustomer(prefix = 'e2e', domain = 'example.com'): Promise<Session> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@${domain}`;
  const response = await api('POST', '/api/v1/auth/register', {
    body: { email, password: 'correct horse battery staple', displayName: `Test ${prefix}` },
  });
  if (response.status !== 201)
    throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  return {
    token: response.body.accessToken,
    refreshToken: response.body.refreshToken,
    userId: response.body.user.id,
    email,
  };
}

export async function loginAdmin(): Promise<string> {
  const response = await api('POST', '/api/v1/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (response.status !== 200)
    throw new Error(`admin login failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.accessToken;
}

export async function placeOrder(
  token: string,
  lines: { productId: string; quantity: number }[],
  paymentMethodToken = 'sim_card_approved',
  key = randomUUID(),
) {
  return api('POST', '/api/v1/orders', {
    token,
    body: { lines, paymentMethodToken },
    headers: { 'Idempotency-Key': key },
  });
}

export const TERMINAL = ['CONFIRMED', 'CANCELLED', 'REQUIRES_REVIEW'];

export async function waitForOrder(token: string, orderId: string, statuses = TERMINAL, timeoutMs = 30_000) {
  return poll(
    async () => {
      const response = await api('GET', `/api/v1/orders/${orderId}`, { token });
      return statuses.includes(response.body?.status) ? response.body : undefined;
    },
    `order ${orderId} to reach ${statuses.join('/')}`,
    timeoutMs,
  );
}

export async function stock(adminToken: string, productId: string) {
  return (await api('GET', `/api/v1/inventory/${productId}`, { token: adminToken })).body as {
    onHand: number;
    reserved: number;
    available: number;
  };
}

/** Finds emails to a recipient in Mailpit (local SMTP preview). */
export async function emailsTo(address: string): Promise<{ ID: string; Subject: string }[]> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  return ((await response.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}

export async function emailText(id: string): Promise<string> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
  return ((await response.json()) as { Text: string }).Text;
}

export const waitForEmail = (address: string, subject: RegExp, timeoutMs = 30_000) =>
  poll(
    async () => (await emailsTo(address)).find((message) => subject.test(message.Subject)),
    `email "${subject}" to ${address}`,
    timeoutMs,
  );
