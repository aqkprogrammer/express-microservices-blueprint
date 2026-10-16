import { buildOpenApiDocument, createOpenApiRegistry, problemResponses } from '@emb/http-kit';
import { z } from 'zod';
import {
  createIntentSchema,
  listPaymentsQuery,
  paymentIdParams,
  paymentSchema,
  refundSchema,
} from './schemas.js';

export function paymentOpenApi(): object {
  const registry = createOpenApiRegistry();
  const security = [{ bearerAuth: [] }];
  const json = <T>(schema: T) => ({ 'application/json': { schema } });
  const idempotencyHeader = z.object({ 'idempotency-key': z.string().min(8).max(128) });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/payments',
    tags: ['Payments'],
    security,
    summary: 'Payments for an order (owner or admin)',
    request: { query: listPaymentsQuery },
    responses: {
      200: { description: 'Payments', content: json(z.object({ data: z.array(paymentSchema) })) },
      ...problemResponses(400, 401),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/payments/{paymentId}',
    tags: ['Payments'],
    security,
    summary: 'Payment status (owner or admin)',
    request: { params: paymentIdParams },
    responses: {
      200: { description: 'Payment', content: json(paymentSchema) },
      ...problemResponses(401, 404),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/payments/intents',
    tags: ['Payments (admin)'],
    security,
    summary: 'Create and authorize a payment intent with the LOCAL SIMULATOR (idempotent)',
    request: { headers: idempotencyHeader, body: { content: json(createIntentSchema) } },
    responses: {
      201: { description: 'Payment intent', content: json(paymentSchema) },
      ...problemResponses(400, 401, 403, 409, 422),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/payments/{paymentId}/capture',
    tags: ['Payments (admin)'],
    security,
    summary: 'Capture an authorized payment (also happens automatically on OrderConfirmed)',
    request: { params: paymentIdParams },
    responses: {
      200: { description: 'Captured payment', content: json(paymentSchema) },
      ...problemResponses(401, 403, 404, 409),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/payments/{paymentId}/refund',
    tags: ['Payments (admin)'],
    security,
    summary: 'Refund a captured payment, fully or partially (idempotent)',
    request: { params: paymentIdParams, headers: idempotencyHeader, body: { content: json(refundSchema) } },
    responses: {
      200: { description: 'Refunded payment', content: json(paymentSchema) },
      ...problemResponses(400, 401, 403, 404, 409, 422),
    },
  });
  return buildOpenApiDocument(registry, {
    title: 'Payment Service API (local simulator)',
    version: '1.0.0',
    description:
      'A LOCAL PAYMENT SIMULATOR. It accepts only simulated method tokens (e.g. `sim_card_approved`), never card data, and makes no PCI DSS claims.',
  });
}
