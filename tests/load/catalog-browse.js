// k6 scenario: anonymous catalog browsing (list, search, detail) through the gateway.
// Exercises Redis cache-aside on the product service.
import { buildSummary } from './summary.js';
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PRODUCT_IDS = [
  '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001',
  '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2002',
  '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2003',
  '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2004',
];

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:list}': ['p(95)<500'],
    'http_req_duration{name:detail}': ['p(95)<500'],
  },
};

export default function () {
  const list = http.get(`${BASE_URL}/api/v1/products?pageSize=10&sort=price`, { tags: { name: 'list' } });
  check(list, { 'list 200': (r) => r.status === 200 });
  const search = http.get(`${BASE_URL}/api/v1/products?q=monitor`, { tags: { name: 'search' } });
  check(search, { 'search 200': (r) => r.status === 200 });
  const id = PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
  const detail = http.get(`${BASE_URL}/api/v1/products/${id}`, { tags: { name: 'detail' } });
  check(detail, { 'detail 200': (r) => r.status === 200 });
  sleep(0.1);
}

export const handleSummary = buildSummary('catalog-browse');
