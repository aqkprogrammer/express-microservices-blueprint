import { paginationQuerySchema, parseWith } from '@emb/http-kit';
import { authenticate, principal, requireRoles, type AccessTokenVerifier } from '@emb/security';
import { Router } from 'express';
import { z } from 'zod';
import type { DeadLetterArchive } from '../dead-letters/archive.js';

const listQuery = paginationQuerySchema.extend({
  status: z.enum(['ARCHIVED', 'REPLAYED', 'DISCARDED']).optional(),
  queue: z.string().max(200).optional(),
});
const idParams = z.object({ id: z.uuid() });

/**
 * Operations API for the dead-letter archive. Administrative: requires an
 * admin token AND is deliberately not routed by the public API gateway.
 */
export function adminRoutes(deps: { archive: DeadLetterArchive; verifier: AccessTokenVerifier }): Router {
  const router = Router();
  router.use('/admin/v1', authenticate(deps.verifier), requireRoles('admin'));

  router.get('/admin/v1/dead-letters', async (req, res) => {
    res.json(await deps.archive.list(parseWith(listQuery, req.query, 'query')));
  });
  router.get('/admin/v1/dead-letters/:id', async (req, res) => {
    res.json(await deps.archive.get(parseWith(idParams, req.params, 'params').id));
  });
  router.post('/admin/v1/dead-letters/:id/replay', async (req, res) => {
    const { id } = parseWith(idParams, req.params, 'params');
    res.json(await deps.archive.replay(id, principal(req).userId));
  });
  router.post('/admin/v1/dead-letters/:id/discard', async (req, res) => {
    const { id } = parseWith(idParams, req.params, 'params');
    res.json(await deps.archive.discard(id, principal(req).userId));
  });
  return router;
}
