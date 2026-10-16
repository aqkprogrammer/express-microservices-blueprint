import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  paginatedResponseSchema,
  problemResponses,
} from '@emb/http-kit';
import {
  adjustmentSchema,
  createInventorySchema,
  listInventoryQuerySchema,
  orderIdParams,
  productIdParams,
  reservationSchema,
  stockSchema,
} from './schemas.js';

export function inventoryOpenApi(): object {
  const registry = createOpenApiRegistry();
  const security = [{ bearerAuth: [] }];
  const json = <T>(schema: T) => ({ 'application/json': { schema } });
  const tags = ['Inventory (admin)'];

  registry.registerPath({
    method: 'get',
    path: '/api/v1/inventory',
    tags,
    security,
    summary: 'List stock levels, optionally only items at or below a threshold',
    request: { query: listInventoryQuerySchema },
    responses: {
      200: { description: 'Stock page', content: json(paginatedResponseSchema(stockSchema)) },
      ...problemResponses(400, 401, 403),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/inventory',
    tags,
    security,
    summary: 'Create an inventory record (normally provisioned automatically from ProductCreated)',
    request: { body: { content: json(createInventorySchema) } },
    responses: {
      201: { description: 'Created', content: json(stockSchema) },
      ...problemResponses(400, 401, 403, 409),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/inventory/{productId}',
    tags,
    security,
    summary: 'Stock for one product',
    request: { params: productIdParams },
    responses: {
      200: { description: 'Stock', content: json(stockSchema) },
      ...problemResponses(401, 403, 404),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/inventory/{productId}/adjustments',
    tags,
    security,
    summary: 'Adjust on-hand stock (audited). Cannot drop below reserved quantity.',
    request: { params: productIdParams, body: { content: json(adjustmentSchema) } },
    responses: {
      200: { description: 'Updated stock', content: json(stockSchema) },
      ...problemResponses(400, 401, 403, 404, 422),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/inventory/reservations/{orderId}',
    tags,
    security,
    summary: 'Reservation state for an order (saga diagnostics)',
    request: { params: orderIdParams },
    responses: {
      200: { description: 'Reservation', content: json(reservationSchema) },
      ...problemResponses(401, 403, 404),
    },
  });
  return buildOpenApiDocument(registry, {
    title: 'Inventory Service API',
    version: '1.0.0',
    description: 'Administrative stock management. Reservations are driven by saga events, not by this API.',
  });
}
