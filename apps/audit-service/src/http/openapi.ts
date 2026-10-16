import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  paginatedResponseSchema,
  problemResponses,
} from '@emb/http-kit';
import { z } from 'zod';
import { auditQuerySchema } from './routes.js';

const auditRecordSchema = z
  .object({
    eventId: z.uuid(),
    eventType: z.string(),
    category: z.enum(['security', 'business', 'operations']),
    producer: z.string(),
    subjectId: z.string().nullable(),
    actorId: z.string().nullable(),
    correlationId: z.string(),
    occurredAt: z.string(),
    recordedAt: z.string(),
    details: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'AuditRecord' });

export function auditOpenApi(): object {
  const registry = createOpenApiRegistry();
  registry.registerPath({
    method: 'get',
    path: '/api/v1/audit-events',
    tags: ['Audit (admin)'],
    security: [{ bearerAuth: [] }],
    summary: 'Search the audit trail',
    request: { query: auditQuerySchema },
    responses: {
      200: {
        description: 'Audit records',
        content: { 'application/json': { schema: paginatedResponseSchema(auditRecordSchema) } },
      },
      ...problemResponses(400, 401, 403),
    },
  });
  return buildOpenApiDocument(registry, {
    title: 'Audit Service API',
    version: '1.0.0',
    description: 'Administrator-only, append-only audit trail.',
  });
}
