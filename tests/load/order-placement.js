// k6 scenario: authenticated customers placing orders (starts the full saga).
// Measures the synchronous API (order accepted = 201); saga completion is
// asynchronous and sampled with a follow-up GET.
import { buildSummary } from './summary.js';
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CUSTOMERS = Number(__ENV.CUSTOMERS || 10);
const PRODUCT_IDS = [
  '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001',
  '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2002',
  '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2007',
];

export const options = {
  scenarios: {
    orders: { executor: 'constant-vus', vus: Number(__ENV.VUS || 10), duration: __ENV.DURATION || '30s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:create_order}': ['p(95)<1000'],
  },
};

export function setup() {
  const tokens = [];
  for (let i = 0; i < CUSTOMERS; i += 1) {
    const response = http.post(
      `${BASE_URL}/api/v1/auth/register`,
      JSON.stringify({
        email: `load-${crypto.randomUUID()}@example.com`,
        password: 'correct horse battery staple',
        displayName: 'Load test',
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    if (response.status !== 201)
      throw new Error(`registration failed: ${response.status} (raise AUTH_RATE_LIMIT_MAX for load tests)`);
    tokens.push(response.json('accessToken'));
  }
  return { tokens };
}

export default function (data) {
  const token = data.tokens[__VU % data.tokens.length];
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'Idempotency-Key': crypto.randomUUID(),
  };
  const body = JSON.stringify({
    lines: [{ productId: PRODUCT_IDS[__ITER % PRODUCT_IDS.length], quantity: 1 }],
    paymentMethodToken: 'sim_card_approved',
  });
  const created = http.post(`${BASE_URL}/api/v1/orders`, body, { headers, tags: { name: 'create_order' } });
  check(created, { 'order accepted (201)': (r) => r.status === 201 });
  sleep(0.5);
  if (created.status === 201) {
    const order = http.get(`${BASE_URL}/api/v1/orders/${created.json('id')}`, {
      headers,
      tags: { name: 'get_order' },
    });
    check(order, { 'order readable': (r) => r.status === 200 });
  }
}

export const handleSummary = buildSummary('order-placement');
