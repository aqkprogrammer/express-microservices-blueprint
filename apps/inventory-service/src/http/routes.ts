import { parseWith } from '@emb/http-kit';
import { authenticate, principal, requireRoles, type AccessTokenVerifier } from '@emb/security';
import { Router } from 'express';
import type { InventoryService } from '../domain/inventory-service.js';
import {
  adjustmentSchema,
  createInventorySchema,
  listInventoryQuerySchema,
  orderIdParams,
  productIdParams,
} from './schemas.js';

/** Inventory management is an administrative API; customers see availability via product-service. */
export function inventoryRoutes(deps: { service: InventoryService; verifier: AccessTokenVerifier }): Router {
  const router = Router();
  router.use('/api/v1/inventory', authenticate(deps.verifier), requireRoles('admin'));

  router.get('/api/v1/inventory', async (req, res) => {
    const query = parseWith(listInventoryQuerySchema, req.query, 'query');
    res.json(await deps.service.listItems(query.page, query.pageSize, query.lowStockThreshold));
  });

  router.post('/api/v1/inventory', async (req, res) => {
    const body = parseWith(createInventorySchema, req.body);
    const item = await deps.service.createItem(body, principal(req).userId);
    res.status(201).location(`/api/v1/inventory/${item.productId}`).json(item);
  });

  router.get('/api/v1/inventory/reservations/:orderId', async (req, res) => {
    const { orderId } = parseWith(orderIdParams, req.params, 'params');
    res.json(await deps.service.getReservation(orderId));
  });

  router.get('/api/v1/inventory/:productId', async (req, res) => {
    const { productId } = parseWith(productIdParams, req.params, 'params');
    res.json(await deps.service.getItem(productId));
  });

  router.post('/api/v1/inventory/:productId/adjustments', async (req, res) => {
    const { productId } = parseWith(productIdParams, req.params, 'params');
    const { delta, reason } = parseWith(adjustmentSchema, req.body);
    res.json(await deps.service.adjust(productId, delta, reason, principal(req).userId));
  });

  return router;
}
