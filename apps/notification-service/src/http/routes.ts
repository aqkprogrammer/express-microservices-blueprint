import { paginationQuerySchema, parseWith } from '@emb/http-kit';
import { authenticate, isAdmin, principal, requireRoles, type AccessTokenVerifier } from '@emb/security';
import { Router } from 'express';
import { z } from 'zod';
import type { NotificationService } from '../domain/notification-service.js';

export const listNotificationsQuery = paginationQuerySchema.extend({
  status: z.enum(['PENDING', 'SENT', 'FAILED']).optional(),
  recipientUserId: z.uuid().optional(),
});
export const templateKeyParams = z.object({ key: z.string().regex(/^[a-z0-9-]+$/) });
export const updateTemplateSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    bodyText: z.string().min(1).max(10_000),
    expectedVersion: z.number().int().positive(),
  })
  .meta({ id: 'UpdateTemplateRequest' });

export function notificationRoutes(deps: {
  service: NotificationService;
  verifier: AccessTokenVerifier;
}): Router {
  const router = Router();
  router.use('/api/v1/notifications', authenticate(deps.verifier));

  // Users see their own notifications; admins can filter by recipient and status.
  router.get('/api/v1/notifications', async (req, res) => {
    const query = parseWith(listNotificationsQuery, req.query, 'query');
    const recipientUserId = isAdmin(req) ? query.recipientUserId : principal(req).userId;
    res.json(await deps.service.list({ ...query, recipientUserId }));
  });

  router.get('/api/v1/notifications/templates', requireRoles('admin'), async (_req, res) => {
    res.json({ data: await deps.service.listTemplates() });
  });

  router.put('/api/v1/notifications/templates/:key', requireRoles('admin'), async (req, res) => {
    const { key } = parseWith(templateKeyParams, req.params, 'params');
    res.json(
      await deps.service.updateTemplate(
        key,
        parseWith(updateTemplateSchema, req.body),
        principal(req).userId,
      ),
    );
  });

  return router;
}
