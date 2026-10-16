import { parseWith, requireIdempotencyKey } from '@emb/http-kit';
import { authenticate, principal, type AccessTokenVerifier } from '@emb/security';
import { Router } from 'express';
import type { OrderService } from '../domain/order-service.js';
import { createOrderSchema, listOrdersQuerySchema, orderIdParams } from '../domain/schemas.js';

export function orderRoutes(deps: { service: OrderService; verifier: AccessTokenVerifier }): Router {
  const router = Router();
  router.use('/api/v1/orders', authenticate(deps.verifier));

  router.post('/api/v1/orders', async (req, res) => {
    const auth = principal(req);
    const idempotencyKey = requireIdempotencyKey(req);
    const input = parseWith(createOrderSchema, req.body);
    const { order, replayed } = await deps.service.create(auth.userId, idempotencyKey, input);
    res
      .status(replayed ? 200 : 201)
      .setHeader('Idempotent-Replayed', String(replayed))
      .location(`/api/v1/orders/${order.id}`)
      .json(order);
  });

  router.get('/api/v1/orders', async (req, res) => {
    res.json(await deps.service.list(principal(req), parseWith(listOrdersQuerySchema, req.query, 'query')));
  });

  router.get('/api/v1/orders/:orderId', async (req, res) => {
    const { orderId } = parseWith(orderIdParams, req.params, 'params');
    res.json(await deps.service.get(orderId, principal(req)));
  });

  router.get('/api/v1/orders/:orderId/history', async (req, res) => {
    const { orderId } = parseWith(orderIdParams, req.params, 'params');
    res.json(await deps.service.history(orderId, principal(req)));
  });

  router.post('/api/v1/orders/:orderId/cancel', async (req, res) => {
    const { orderId } = parseWith(orderIdParams, req.params, 'params');
    res.json(await deps.service.cancel(orderId, principal(req)));
  });

  return router;
}
