import { parseWith, requireIdempotencyKey } from '@emb/http-kit';
import {
  authenticate,
  principal,
  requireInternalToken,
  requireRoles,
  type AccessTokenVerifier,
} from '@emb/security';
import { Router } from 'express';
import type { IdempotencyStore } from '../domain/idempotency.js';
import type { PaymentService } from '../domain/payment-service.js';
import {
  createIntentSchema,
  listPaymentsQuery,
  orderIdParams,
  paymentIdParams,
  refundSchema,
} from './schemas.js';

export function paymentRoutes(deps: {
  service: PaymentService;
  idempotency: IdempotencyStore;
  verifier: AccessTokenVerifier;
  internalToken: string;
}): Router {
  const router = Router();
  const { service, idempotency } = deps;
  router.use('/api/v1/payments', authenticate(deps.verifier));
  const admin = requireRoles('admin');

  router.get('/api/v1/payments', async (req, res) => {
    const { orderId } = parseWith(listPaymentsQuery, req.query, 'query');
    res.json({ data: await service.listForOrder(orderId, principal(req)) });
  });

  router.get('/api/v1/payments/:paymentId', async (req, res) => {
    const { paymentId } = parseWith(paymentIdParams, req.params, 'params');
    res.json(await service.get(paymentId, principal(req)));
  });

  // Back-office operations that move money require an Idempotency-Key.
  router.post('/api/v1/payments/intents', admin, async (req, res) => {
    const key = requireIdempotencyKey(req);
    const input = parseWith(createIntentSchema, req.body);
    const result = await idempotency.execute(`${principal(req).userId}:intents`, key, input, async () => ({
      status: 201,
      body: await service.createIntent(input),
    }));
    res.status(result.status).setHeader('Idempotent-Replayed', String(result.replayed)).json(result.body);
  });

  router.post('/api/v1/payments/:paymentId/capture', admin, async (req, res) => {
    const { paymentId } = parseWith(paymentIdParams, req.params, 'params');
    res.json(await service.capture(paymentId));
  });

  router.post('/api/v1/payments/:paymentId/refund', admin, async (req, res) => {
    const key = requireIdempotencyKey(req);
    const { paymentId } = parseWith(paymentIdParams, req.params, 'params');
    const input = parseWith(refundSchema, req.body);
    const result = await idempotency.execute(
      `${principal(req).userId}:refund:${paymentId}`,
      key,
      input,
      async () => ({
        status: 200,
        body: await service.refund(paymentId, input.amountCents, input.reason),
      }),
    );
    res.status(result.status).setHeader('Idempotent-Replayed', String(result.replayed)).json(result.body);
  });

  // Internal: used by the order saga to reconcile after a payment-step timeout.
  router.get(
    '/internal/v1/payments/by-order/:orderId',
    requireInternalToken(deps.internalToken),
    async (req, res) => {
      const { orderId } = parseWith(orderIdParams, req.params, 'params');
      res.json(await service.findByOrder(orderId));
    },
  );

  return router;
}
