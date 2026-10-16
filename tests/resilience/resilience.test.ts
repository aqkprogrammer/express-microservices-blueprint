/**
 * Resilience scenarios against the running Docker Compose stack. These tests
 * stop and start containers (`docker compose stop|start|restart`), so run
 * them on a local or CI stack only — never against a shared environment.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCTS,
  WORKER_URL,
  api,
  loginAdmin,
  placeOrder,
  poll,
  registerCustomer,
  stock,
  waitForOrder,
  type Session,
} from '../support/api.js';

const root = join(import.meta.dirname, '../..');
const RABBITMQ_API = process.env.RABBITMQ_API_URL ?? 'http://localhost:15672/api';
const RABBITMQ_AUTH = `Basic ${Buffer.from(`${process.env.RABBITMQ_USER ?? 'emb'}:${process.env.RABBITMQ_PASSWORD ?? 'local-dev-rabbitmq-password'}`).toString('base64')}`;

function compose(...args: string[]): void {
  execFileSync('docker', ['compose', ...args], { cwd: root, stdio: 'pipe', timeout: 180_000 });
}

async function withServiceStopped<T>(
  service: string,
  during: () => Promise<T>,
  waitHealthy = true,
): Promise<T> {
  compose('stop', service);
  try {
    return await during();
  } finally {
    compose('start', service);
    if (waitHealthy) compose('up', '-d', '--wait', service);
  }
}

/** Publishes a raw message through the RabbitMQ management API (management UI port, 127.0.0.1 only). */
async function publishRaw(routingKey: string, payload: string, properties: Record<string, unknown> = {}) {
  const response = await fetch(`${RABBITMQ_API}/exchanges/%2F/domain.events/publish`, {
    method: 'POST',
    headers: { authorization: RABBITMQ_AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({
      routing_key: routingKey,
      payload,
      payload_encoding: 'string',
      properties: { delivery_mode: 2, content_type: 'application/json', ...properties },
    }),
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { routed: boolean }).routed).toBe(true);
}

async function deadLetters(admin: string, queue: string) {
  const response = await api(
    'GET',
    `/admin/v1/dead-letters?queue=${encodeURIComponent(queue)}&pageSize=100`,
    { token: admin, baseUrl: WORKER_URL },
  );
  return response.body.data as {
    id: string;
    messageId: string;
    reason: string;
    status: string;
    occurrences: number;
    eventType: string | null;
  }[];
}

let customer: Session;
let admin: string;

beforeAll(async () => {
  [customer, admin] = await Promise.all([registerCustomer('resilience'), loginAdmin()]);
});

afterAll(() => {
  // Leave the stack as we found it, whatever happened above.
  compose('up', '-d', '--wait');
});

describe('resilience (Docker Compose stack)', () => {
  it('accepts orders during a RabbitMQ outage and completes them after recovery (outbox)', async () => {
    const orderId = await withServiceStopped('rabbitmq', async () => {
      const created = await placeOrder(customer.token, [{ productId: PRODUCTS.stand, quantity: 1 }]);
      expect(created.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(
        (await api('GET', `/api/v1/orders/${created.body.id}`, { token: customer.token })).body.status,
      ).toBe('PENDING');
      return created.body.id as string;
    });
    const order = await waitForOrder(customer.token, orderId, undefined, 120_000);
    expect(order.status).toBe('CONFIRMED');
  });

  it('keeps the catalog and the gateway working without Redis (fail-open cache and rate limits)', async () => {
    await withServiceStopped('redis', async () => {
      const started = Date.now();
      const products = await api('GET', '/api/v1/products?pageSize=5');
      expect(products.status).toBe(200);
      expect(products.body.data.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect((await api('GET', `/api/v1/products/${PRODUCTS.keyboard}`)).status).toBe(200);
    });
  });

  it('fails fast with problem details while PostgreSQL is down and recovers afterwards', async () => {
    await withServiceStopped(
      'postgres',
      async () => {
        const response = await api('GET', '/api/v1/orders', { token: customer.token });
        expect(response.status).toBeGreaterThanOrEqual(500);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(JSON.stringify(response.body)).not.toMatch(/postgres|password|ECONNREFUSED/i);
      },
      false,
    );
    compose('up', '-d', '--wait', 'postgres');
    await poll(
      async () => (await api('GET', '/api/v1/orders', { token: customer.token })).status === 200 || undefined,
      'order API recovery',
      60_000,
    );
  });

  it('completes the saga when a participant (payment service) was down', async () => {
    const orderId = await withServiceStopped('payment-service', async () => {
      const created = await placeOrder(customer.token, [{ productId: PRODUCTS.stand, quantity: 1 }]);
      await waitForOrder(customer.token, created.body.id, ['AWAITING_PAYMENT'], 30_000);
      return created.body.id as string;
    });
    expect((await waitForOrder(customer.token, orderId, undefined, 90_000)).status).toBe('CONFIRMED');
  });

  it('resumes in-flight sagas after the orchestrator restarts', async () => {
    const created = await placeOrder(customer.token, [{ productId: PRODUCTS.stand, quantity: 1 }]);
    compose('restart', 'order-service');
    compose('up', '-d', '--wait', 'order-service');
    expect((await waitForOrder(customer.token, created.body.id, undefined, 90_000)).status).toBe('CONFIRMED');
  });

  it('completes a compensation (refund) once the unavailable participant returns', async () => {
    const created = await placeOrder(customer.token, [{ productId: PRODUCTS.stand, quantity: 1 }]);
    const order = await waitForOrder(customer.token, created.body.id);
    expect(order.status).toBe('CONFIRMED');
    await poll(
      async () =>
        (await api('GET', `/api/v1/payments?orderId=${order.id}`, { token: customer.token })).body.data[0]
          ?.status === 'CAPTURED' || undefined,
      'capture',
    );
    await withServiceStopped('payment-service', async () => {
      const cancelled = await api('POST', `/api/v1/orders/${order.id}/cancel`, { token: customer.token });
      expect(cancelled.body.status).toBe('CANCELLED');
    });
    await poll(
      async () =>
        (await api('GET', `/api/v1/payments?orderId=${order.id}`, { token: customer.token })).body.data[0]
          ?.status === 'REFUNDED' || undefined,
      'refund after recovery',
      60_000,
    );
  });

  it('makes duplicate deliveries of the same event harmless (idempotent consumers)', async () => {
    const created = await placeOrder(customer.token, [{ productId: PRODUCTS.keyboard, quantity: 1 }]);
    const order = await waitForOrder(customer.token, created.body.id);
    await poll(
      async () =>
        (await api('GET', `/api/v1/payments?orderId=${order.id}`, { token: customer.token })).body.data[0]
          ?.status === 'CAPTURED' || undefined,
      'capture',
    );
    const before = await stock(admin, PRODUCTS.keyboard);
    const envelope = {
      id: randomUUID(),
      type: 'OrderConfirmed',
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'order-service',
      correlationId: order.id,
      subject: order.id,
      payload: {
        orderId: order.id,
        customerId: order.customerId,
        currency: order.currency,
        totalCents: order.totalCents,
        paymentId: order.paymentId,
        lines: order.lines.map(({ lineTotalCents: _total, ...line }: { lineTotalCents: number }) => line),
      },
    };
    // Same message delivered twice, plus a redelivery of the same fact under a new message ID.
    await publishRaw('order.confirmed.v1', JSON.stringify(envelope), { message_id: envelope.id });
    await publishRaw('order.confirmed.v1', JSON.stringify(envelope), { message_id: envelope.id });
    await publishRaw('order.confirmed.v1', JSON.stringify({ ...envelope, id: randomUUID() }));
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await stock(admin, PRODUCTS.keyboard)).toMatchObject({
      onHand: before.onHand,
      reserved: before.reserved,
    });
    const [payment] = (await api('GET', `/api/v1/payments?orderId=${order.id}`, { token: customer.token }))
      .body.data;
    expect(payment).toMatchObject({ status: 'CAPTURED', capturedCents: order.totalCents });
  });

  it('dead-letters malformed messages, archives them, and supports replay', async () => {
    const messageId = `poison-${randomUUID()}`;
    await publishRaw('order.created.v1', '{"this is": "not an envelope"', {
      message_id: messageId,
      type: 'OrderCreated.v1',
    });
    const letter = await poll(
      async () =>
        (await deadLetters(admin, 'inventory-service.events')).find((entry) => entry.messageId === messageId),
      'dead letter archived by the worker',
    );
    expect(letter).toMatchObject({ reason: 'invalid_message', status: 'ARCHIVED', occurrences: 1 });
    // The gateway never exposes the admin API.
    expect((await api('GET', '/admin/v1/dead-letters', { token: admin })).status).toBe(404);

    const replay = await api('POST', `/admin/v1/dead-letters/${letter.id}/replay`, {
      token: admin,
      baseUrl: WORKER_URL,
    });
    expect(replay.body.status).toBe('REPLAYED');
    // Still malformed, so it dead-letters again and is re-archived with a higher occurrence count.
    await poll(
      async () =>
        (await deadLetters(admin, 'inventory-service.events')).find(
          (entry) => entry.messageId === messageId && entry.occurrences === 2,
        ),
      're-archived after replay',
    );
  });

  it('retries a failing email delivery, then dead-letters it and marks the notification FAILED', async () => {
    const bounce = await registerCustomer('bounce', 'bounce.test');
    const failed = await poll(
      async () => {
        const response = await api(
          'GET',
          `/api/v1/notifications?status=FAILED&recipientUserId=${bounce.userId}`,
          { token: admin },
        );
        return response.body.data[0];
      },
      'notification to exhaust its retries (2s + 10s + 30s)',
      120_000,
      2_000,
    );
    expect(failed).toMatchObject({ template: 'welcome', status: 'FAILED', attempts: 4 });
    const letters = await poll(async () => {
      const entries = await deadLetters(admin, 'notification-service.events');
      return entries.find(
        (entry) =>
          entry.eventType === 'UserRegistered.v1' &&
          entry.reason === 'retries_exhausted' &&
          entry.status === 'ARCHIVED',
      );
    }, 'dead letter for the failed delivery');
    expect(letters).toBeDefined();
  }, 180_000);
});
