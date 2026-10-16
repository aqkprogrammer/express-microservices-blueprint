import { parseWith } from '@emb/http-kit';
import {
  authenticate,
  isAdmin,
  requireInternalToken,
  requireRoles,
  type AccessTokenVerifier,
} from '@emb/security';
import { Router } from 'express';
import { z } from 'zod';
import { createProductSchema, listProductsQuerySchema, updateProductSchema } from '../domain/product.js';
import type { ProductService } from '../domain/product-service.js';

export const productIdParams = z.object({ productId: z.uuid() });
export const snapshotQuerySchema = z.object({
  ids: z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.uuid()).min(1).max(50)),
});

export function productRoutes(deps: {
  service: ProductService;
  verifier: AccessTokenVerifier;
  internalToken: string;
}): Router {
  const router = Router();
  const { service, verifier } = deps;
  const optionalAuth = authenticate(verifier, { optional: true });
  const adminOnly = [authenticate(verifier), requireRoles('admin')];

  // Public catalog (anonymous allowed; admins additionally see drafts and can filter by status).
  router.get('/api/v1/products', optionalAuth, async (req, res) => {
    const query = parseWith(listProductsQuerySchema, req.query, 'query');
    res.json(await service.list(query, isAdmin(req)));
  });

  router.get('/api/v1/products/:productId', optionalAuth, async (req, res) => {
    const { productId } = parseWith(productIdParams, req.params, 'params');
    res.json(await service.get(productId, isAdmin(req)));
  });

  // Administrative catalog management.
  router.post('/api/v1/products', ...adminOnly, async (req, res) => {
    const product = await service.create(parseWith(createProductSchema, req.body));
    res.status(201).location(`/api/v1/products/${product.id}`).json(product);
  });

  router.patch('/api/v1/products/:productId', ...adminOnly, async (req, res) => {
    const { productId } = parseWith(productIdParams, req.params, 'params');
    res.json(await service.update(productId, parseWith(updateProductSchema, req.body)));
  });

  // Internal: price snapshots for order-service. Never routed by the gateway.
  router.get('/internal/v1/products', requireInternalToken(deps.internalToken), async (req, res) => {
    const { ids } = parseWith(snapshotQuerySchema, req.query, 'query');
    res.json({ data: await service.findForSnapshot(ids) });
  });

  return router;
}
