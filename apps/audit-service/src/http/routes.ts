import { paginationQuerySchema, parseWith } from '@emb/http-kit';
import { authenticate, requireRoles, type AccessTokenVerifier } from '@emb/security';
import { Router } from 'express';
import { z } from 'zod';
import type { AuditService } from '../domain/audit-service.js';

export const auditQuerySchema = paginationQuerySchema.extend({
  eventType: z
    .string()
    .regex(/^[A-Za-z]+\.v\d+$/)
    .optional(),
  category: z.enum(['security', 'business', 'operations']).optional(),
  subjectId: z.string().max(128).optional(),
  actorId: z.uuid().optional(),
  correlationId: z.string().max(128).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Audit data is restricted to administrators. */
export function auditRoutes(deps: { service: AuditService; verifier: AccessTokenVerifier }): Router {
  const router = Router();
  router.get('/api/v1/audit-events', authenticate(deps.verifier), requireRoles('admin'), async (req, res) => {
    res.json(await deps.service.search(parseWith(auditQuerySchema, req.query, 'query')));
  });
  return router;
}
