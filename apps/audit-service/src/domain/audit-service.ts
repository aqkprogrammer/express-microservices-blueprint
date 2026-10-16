import type { EventEnvelope } from '@emb/contracts';
import { paginated } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { counter } from '@emb/observability';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { actorOf, categorize, sanitizeDetails } from './sanitize.js';

const recorded = counter('audit_records_total', 'Audit records written', ['category']);

export interface AuditQuery {
  page: number;
  pageSize: number;
  eventType?: string | undefined;
  category?: 'security' | 'business' | 'operations' | undefined;
  subjectId?: string | undefined;
  actorId?: string | undefined;
  correlationId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export class AuditService {
  constructor(private readonly deps: { prisma: PrismaClient; logger: Logger }) {}

  /** Idempotent by event ID (primary key); duplicates are ignored. */
  async record(envelope: EventEnvelope): Promise<void> {
    const payload = (
      typeof envelope.payload === 'object' && envelope.payload !== null ? envelope.payload : {}
    ) as Record<string, unknown>;
    const category = categorize(envelope.type);
    const actorId = actorOf(payload);
    const result = await this.deps.prisma.auditRecord.createMany({
      data: [
        {
          eventId: envelope.id,
          eventType: `${envelope.type}.v${envelope.version}`,
          category,
          producer: envelope.producer,
          subjectId: envelope.subject ?? null,
          actorId: actorId ?? null,
          correlationId: envelope.correlationId,
          occurredAt: new Date(envelope.occurredAt),
          details: sanitizeDetails(payload) as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (result.count > 0) recorded.inc({ category });
  }

  async search(query: AuditQuery) {
    const where: Prisma.AuditRecordWhereInput = {
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      ...(query.from || query.to ? { occurredAt: { gte: query.from, lte: query.to } } : {}),
    };
    const [rows, total] = await this.deps.prisma.$transaction([
      this.deps.prisma.auditRecord.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { eventId: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.deps.prisma.auditRecord.count({ where }),
    ]);
    return paginated(
      rows.map((row) => ({
        eventId: row.eventId,
        eventType: row.eventType,
        category: row.category,
        producer: row.producer,
        subjectId: row.subjectId,
        actorId: row.actorId,
        correlationId: row.correlationId,
        occurredAt: row.occurredAt.toISOString(),
        recordedAt: row.recordedAt.toISOString(),
        details: row.details,
      })),
      total,
      query.page,
      query.pageSize,
    );
  }

  async applyRetention(retentionDays: number): Promise<number> {
    const { count } = await this.deps.prisma.auditRecord.deleteMany({
      where: { occurredAt: { lt: new Date(Date.now() - retentionDays * 86_400_000) } },
    });
    if (count > 0) this.deps.logger.info({ deleted: count, retentionDays }, 'audit retention applied');
    return count;
  }
}
