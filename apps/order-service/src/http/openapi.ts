import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  paginatedResponseSchema,
  problemResponses,
} from '@emb/http-kit';
import { z } from 'zod';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderHistorySchema,
  orderIdParams,
  orderSchema,
} from '../domain/schemas.js';

export function orderOpenApi(): object {
  const registry = createOpenApiRegistry();
  const security = [{ bearerAuth: [] }];
  const json = <T>(schema: T) => ({ 'application/json': { schema } });
  const tags = ['Orders'];

  registry.registerPath({
    method: 'post',
    path: '/api/v1/orders',
    tags,
    security,
    summary: 'Place an order (idempotent; starts the order saga)',
    description:
      'Requires an `Idempotency-Key` header. Returns 201 with status PENDING; the saga then reserves stock and authorizes payment asynchronously. Repeating the request with the same key returns the original order with 200 and `Idempotent-Replayed: true`.',
    request: {
      headers: z.object({ 'idempotency-key': z.string().min(8).max(128) }),
      body: { content: json(createOrderSchema) },
    },
    responses: {
      201: { description: 'Order accepted', content: json(orderSchema) },
      200: { description: 'Replay of a previously accepted request', content: json(orderSchema) },
      ...problemResponses(400, 401, 422, 503),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/orders',
    tags,
    security,
    summary: "List the caller's orders (admins: all orders, filterable by customer)",
    request: { query: listOrdersQuerySchema },
    responses: {
      200: { description: 'Orders page', content: json(paginatedResponseSchema(orderSchema)) },
      ...problemResponses(400, 401, 403),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/orders/{orderId}',
    tags,
    security,
    summary: 'Order details including saga step',
    request: { params: orderIdParams },
    responses: { 200: { description: 'Order', content: json(orderSchema) }, ...problemResponses(401, 404) },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/orders/{orderId}/history',
    tags,
    security,
    summary: 'Status transition history',
    request: { params: orderIdParams },
    responses: {
      200: { description: 'History', content: json(orderHistorySchema) },
      ...problemResponses(401, 404),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/orders/{orderId}/cancel',
    tags,
    security,
    summary: 'Cancel an order (triggers stock release and payment void/refund)',
    request: { params: orderIdParams },
    responses: {
      200: { description: 'Cancelled order', content: json(orderSchema) },
      ...problemResponses(401, 404, 409),
    },
  });
  return buildOpenApiDocument(registry, {
    title: 'Order Service API',
    version: '1.0.0',
    description:
      'Order placement and lifecycle. Orders are processed by an orchestrated saga with a transactional outbox.',
  });
}
