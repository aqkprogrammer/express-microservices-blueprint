import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  paginatedResponseSchema,
  problemResponses,
} from '@emb/http-kit';
import { z } from 'zod';
import { listNotificationsQuery, templateKeyParams, updateTemplateSchema } from './routes.js';

const notificationSchema = z
  .object({
    id: z.uuid(),
    recipientUserId: z.uuid(),
    template: z.string(),
    channel: z.string(),
    status: z.enum(['PENDING', 'SENT', 'FAILED']),
    attempts: z.number().int(),
    lastError: z.string().nullable(),
    sentAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'Notification' });
const templateSchema = z
  .object({
    key: z.string(),
    channel: z.string(),
    subject: z.string(),
    bodyText: z.string(),
    version: z.number().int(),
    placeholders: z.array(z.string()),
    updatedAt: z.string(),
  })
  .meta({ id: 'NotificationTemplate' });

export function notificationOpenApi(): object {
  const registry = createOpenApiRegistry();
  const security = [{ bearerAuth: [] }];
  const json = <T>(schema: T) => ({ 'application/json': { schema } });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/notifications',
    tags: ['Notifications'],
    security,
    summary: 'Delivery status of notifications (own; admins: all)',
    request: { query: listNotificationsQuery },
    responses: {
      200: { description: 'Notifications page', content: json(paginatedResponseSchema(notificationSchema)) },
      ...problemResponses(400, 401),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/notifications/templates',
    tags: ['Notifications (admin)'],
    security,
    summary: 'List templates',
    responses: {
      200: { description: 'Templates', content: json(z.object({ data: z.array(templateSchema) })) },
      ...problemResponses(401, 403),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/v1/notifications/templates/{key}',
    tags: ['Notifications (admin)'],
    security,
    summary: 'Edit a template (versioned, optimistic concurrency)',
    request: { params: templateKeyParams, body: { content: json(updateTemplateSchema) } },
    responses: {
      200: { description: 'Template', content: json(templateSchema) },
      ...problemResponses(400, 401, 403, 404, 409, 422),
    },
  });
  return buildOpenApiDocument(registry, {
    title: 'Notification Service API',
    version: '1.0.0',
    description: 'Notification delivery status and template management.',
  });
}
