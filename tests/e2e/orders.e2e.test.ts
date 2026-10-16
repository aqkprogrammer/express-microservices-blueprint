import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCTS,
  api,
  loginAdmin,
  placeOrder,
  poll,
  registerCustomer,
  stock,
  waitForEmail,
  waitForOrder,
  type Session,
} from '../support/api.js';

let customer: Session;
let admin: string;

beforeAll(async () => {
  [customer, admin] = await Promise.all([registerCustomer('orders'), loginAdmin()]);
});

const paymentsFor = async (orderId: string) =>
  (await api('GET', `/api/v1/payments?orderId=${orderId}`, { token: customer.token })).body.data;

describe('order processing saga (end to end through the gateway)', () => {
  it('confirms an order, captures payment, commits stock and emails the customer', async () => {
    const before = await stock(admin, PRODUCTS.keyboard);
    const created = await placeOrder(customer.token, [{ productId: PRODUCTS.keyboard, quantity: 2 }]);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'PENDING', totalCents: 25_800 });
    expect(created.headers.get('location')).toBe(`/api/v1/orders/${created.body.id}`);

    const order = await waitForOrder(customer.token, created.body.id);
    expect(order).toMatchObject({ status: 'CONFIRMED', saga: { step: 'COMPLETED' } });
    const payment = await poll(
      async () => (await paymentsFor(order.id)).find((p: { status: string }) => p.status === 'CAPTURED'),
      'payment capture',
    );
    expect(payment.amountCents).toBe(25_800);
    await poll(
      async () => (await stock(admin, PRODUCTS.keyboard)).onHand === before.onHand - 2 || undefined,
      'stock commit',
    );
    const history = (
      await api('GET', `/api/v1/orders/${order.id}/history`, { token: customer.token })
    ).body.map((h: { toStatus: string }) => h.toStatus);
    expect(history).toEqual(['PENDING', 'AWAITING_PAYMENT', 'CONFIRMED']);
    await waitForEmail(customer.email, /confirmed/);
  });

  it('cancels a declined payment and releases the reserved stock (compensation)', async () => {
    const before = await stock(admin, PRODUCTS.mouse);
    const created = await placeOrder(
      customer.token,
      [{ productId: PRODUCTS.mouse, quantity: 3 }],
      'sim_card_declined',
    );
    const order = await waitForOrder(customer.token, created.body.id);
    expect(order).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'payment_failed',
      saga: { step: 'COMPENSATED' },
    });
    const reservation = await poll(async () => {
      const response = await api('GET', `/api/v1/inventory/reservations/${order.id}`, { token: admin });
      return response.body?.status === 'RELEASED' ? response.body : undefined;
    }, 'reservation release');
    expect(reservation.lines).toEqual([{ productId: PRODUCTS.mouse, quantity: 3 }]);
    await poll(async () => {
      const after = await stock(admin, PRODUCTS.mouse);
      return (after.onHand === before.onHand && after.reserved === before.reserved) || undefined;
    }, 'stock restored');
    expect((await paymentsFor(order.id))[0]).toMatchObject({ status: 'FAILED', failureReason: 'declined' });
    await waitForEmail(customer.email, /cancelled/);
  });

  it('cancels when stock is insufficient', async () => {
    const created = await placeOrder(customer.token, [{ productId: PRODUCTS.headphones, quantity: 100 }]);
    const order = await waitForOrder(customer.token, created.body.id);
    expect(order).toMatchObject({ status: 'CANCELLED', cancellationReason: 'out_of_stock' });
    // No payment is ever requested (the payment service only keeps an internal tombstone).
    expect(await paymentsFor(order.id)).toEqual([]);
  });

  it('never oversells: concurrent orders for the last units', async () => {
    const sku = `E2E-${randomUUID().slice(0, 6).toUpperCase()}`;
    const product = await api('POST', '/api/v1/products', {
      token: admin,
      body: { sku, name: 'Scarce item', category: 'e2e', priceCents: 500, status: 'active' },
    });
    expect(product.status).toBe(201);
    // Inventory provisions the item from ProductCreated; then stock it with 3 units.
    await poll(
      async () =>
        (await api('GET', `/api/v1/inventory/${product.body.id}`, { token: admin })).status === 200 ||
        undefined,
      'inventory provisioning',
    );
    await api('POST', `/api/v1/inventory/${product.body.id}/adjustments`, {
      token: admin,
      body: { delta: 3, reason: 'e2e stock' },
    });

    const buyers = await Promise.all(Array.from({ length: 6 }, () => registerCustomer('race')));
    const created = await Promise.all(
      buyers.map((buyer) => placeOrder(buyer.token, [{ productId: product.body.id, quantity: 1 }])),
    );
    const outcomes = await Promise.all(
      created.map((response, index) => waitForOrder(buyers[index]!.token, response.body.id)),
    );
    const statuses = outcomes.map((order) => order.status).sort();
    expect(statuses).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    await poll(async () => {
      const level = await stock(admin, product.body.id);
      return (level.onHand === 0 && level.reserved === 0) || undefined;
    }, 'all stock committed');
  });

  it('treats a repeated Idempotency-Key as the same order and rejects key reuse with another body', async () => {
    const key = randomUUID();
    const first = await placeOrder(
      customer.token,
      [{ productId: PRODUCTS.stand, quantity: 1 }],
      'sim_card_approved',
      key,
    );
    const replay = await placeOrder(
      customer.token,
      [{ productId: PRODUCTS.stand, quantity: 1 }],
      'sim_card_approved',
      key,
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    const reuse = await placeOrder(
      customer.token,
      [{ productId: PRODUCTS.stand, quantity: 2 }],
      'sim_card_approved',
      key,
    );
    expect(reuse.status).toBe(422);
    expect(reuse.body.code).toBe('idempotency_key_reused');
    const missing = await api('POST', '/api/v1/orders', {
      token: customer.token,
      body: { lines: [{ productId: PRODUCTS.stand, quantity: 1 }] },
    });
    expect(missing.status).toBe(400);
  });

  it('refunds and restocks when a confirmed order is cancelled', async () => {
    const before = await stock(admin, PRODUCTS.webcam);
    const created = await placeOrder(customer.token, [{ productId: PRODUCTS.webcam, quantity: 1 }]);
    const order = await waitForOrder(customer.token, created.body.id);
    expect(order.status).toBe('CONFIRMED');
    await poll(async () => (await paymentsFor(order.id))[0]?.status === 'CAPTURED' || undefined, 'capture');
    const cancelled = await api('POST', `/api/v1/orders/${order.id}/cancel`, { token: customer.token });
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancellationReason: 'customer_requested' });
    const refunded = await poll(
      async () => (await paymentsFor(order.id)).find((p: { status: string }) => p.status === 'REFUNDED'),
      'refund',
    );
    expect(refunded.refundedCents).toBe(order.totalCents);
    await poll(
      async () => (await stock(admin, PRODUCTS.webcam)).onHand === before.onHand || undefined,
      'restock',
    );
    await waitForEmail(customer.email, /Refund issued/);
    expect((await api('POST', `/api/v1/orders/${order.id}/cancel`, { token: customer.token })).status).toBe(
      409,
    );
  });

  it('recovers from transient payment-provider errors through message retries', async () => {
    const created = await placeOrder(
      customer.token,
      [{ productId: PRODUCTS.stand, quantity: 1 }],
      'sim_transient_error',
    );
    const order = await waitForOrder(customer.token, created.body.id, undefined, 45_000);
    expect(order.status).toBe('CONFIRMED');
    const [payment] = await paymentsFor(order.id);
    expect(payment.authorizationAttempts).toBeGreaterThanOrEqual(3);
  });

  it('reconciles a payment-provider timeout instead of assuming failure', async () => {
    const created = await placeOrder(
      customer.token,
      [{ productId: PRODUCTS.stand, quantity: 1 }],
      'sim_provider_timeout',
    );
    // The simulator reports the authorization as approved once queried after ~20s.
    const order = await waitForOrder(customer.token, created.body.id, undefined, 120_000);
    expect(order.status).toBe('CONFIRMED');
    expect(order.saga.paymentAttempts).toBeGreaterThanOrEqual(1);
  }, 150_000);
});
