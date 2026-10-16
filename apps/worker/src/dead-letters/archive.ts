import { createHash, randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, paginated } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { HEADERS, type RabbitMQClient } from '@emb/messaging';
import { counter, gauge } from '@emb/observability';
import type { ConsumeMessage } from 'amqplib';
import type { PrismaClient } from '../generated/prisma/client.js';

const archived = counter('dead_letters_archived_total', 'Dead-lettered messages archived', [
  'queue',
  'reason',
]);
const replayed = counter('dead_letters_replayed_total', 'Dead letters replayed to their original queue', [
  'queue',
]);

/** Headers that describe a previous failure and must not follow a replayed message. */
const FAILURE_HEADERS = new Set<string>([
  HEADERS.retryAttempt,
  HEADERS.lastError,
  HEADERS.deadLetterReason,
  'x-death',
  'x-first-death-queue',
  'x-first-death-reason',
  'x-first-death-exchange',
  'x-last-death-queue',
  'x-last-death-reason',
  'x-last-death-exchange',
  'x-delivery-count',
]);

const MAX_BODY_BYTES = 1_048_576;

function header(message: ConsumeMessage, name: string): string | undefined {
  const value = message.properties.headers?.[name] as unknown;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Normalises the two ways a message reaches the archive: our consumers'
 * explicit dead-lettering (x-original-queue, x-dead-letter-reason headers) and
 * RabbitMQ's native quorum-queue dead-lettering after the delivery limit
 * (x-first-death-* headers).
 */
export function describeDeadLetter(message: ConsumeMessage) {
  const body = message.content.subarray(0, MAX_BODY_BYTES).toString('utf8');
  const originalQueue =
    header(message, HEADERS.originalQueue) ?? header(message, 'x-first-death-queue') ?? 'unknown';
  const reason =
    header(message, HEADERS.deadLetterReason) ?? header(message, 'x-first-death-reason') ?? 'unknown';
  const messageId = message.properties.messageId
    ? String(message.properties.messageId)
    : createHash('sha256').update(message.content).digest('hex');
  const safeHeaders: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(message.properties.headers ?? {})) {
    if (typeof value === 'string' || typeof value === 'number')
      safeHeaders[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    else if (Buffer.isBuffer(value)) safeHeaders[key] = value.toString('utf8').slice(0, 500);
  }
  return {
    messageId,
    originalQueue,
    originalExchange:
      header(message, HEADERS.originalExchange) ?? header(message, 'x-first-death-exchange') ?? null,
    routingKey: header(message, HEADERS.originalRoutingKey) ?? message.fields.routingKey,
    eventType: message.properties.type ? String(message.properties.type) : null,
    reason,
    lastError: header(message, HEADERS.lastError) ?? null,
    correlationId: message.properties.correlationId ? String(message.properties.correlationId) : null,
    body,
    headers: safeHeaders,
  };
}

export class DeadLetterArchive {
  constructor(private readonly deps: { prisma: PrismaClient; rabbit: RabbitMQClient; logger: Logger }) {
    const { prisma } = deps;
    gauge('dead_letters_open', 'Archived dead letters awaiting a decision', [], async function collect() {
      this.set(await prisma.deadLetter.count({ where: { status: 'ARCHIVED' } }).catch(() => 0));
    });
  }

  /** Idempotent: re-archiving the same message increments its occurrence count. */
  async archive(message: ConsumeMessage): Promise<void> {
    const letter = describeDeadLetter(message);
    await this.deps.prisma.$executeRaw`
      INSERT INTO dead_letters (id, message_id, original_queue, original_exchange, routing_key, event_type, reason,
                                last_error, correlation_id, body, headers)
      VALUES (${randomUUID()}::uuid, ${letter.messageId}, ${letter.originalQueue}, ${letter.originalExchange},
              ${letter.routingKey}, ${letter.eventType}, ${letter.reason}, ${letter.lastError}, ${letter.correlationId},
              ${letter.body}, ${JSON.stringify(letter.headers)}::jsonb)
      ON CONFLICT (message_id, original_queue) DO UPDATE
         SET occurrences = dead_letters.occurrences + 1,
             last_seen_at = now(),
             status = 'ARCHIVED',
             reason = EXCLUDED.reason,
             last_error = EXCLUDED.last_error,
             resolved_at = NULL,
             resolved_by = NULL`;
    archived.inc({ queue: letter.originalQueue, reason: letter.reason });
    this.deps.logger.warn(
      {
        originalQueue: letter.originalQueue,
        reason: letter.reason,
        eventType: letter.eventType,
        messageId: letter.messageId,
        correlationId: letter.correlationId,
      },
      'dead letter archived',
    );
  }

  async list(query: {
    page: number;
    pageSize: number;
    status?: string | undefined;
    queue?: string | undefined;
  }) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.queue ? { originalQueue: query.queue } : {}),
    };
    const [rows, total] = await this.deps.prisma.$transaction([
      this.deps.prisma.deadLetter.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.deps.prisma.deadLetter.count({ where }),
    ]);
    return paginated(
      rows.map(({ body: _body, headers: _headers, ...summary }) => summary),
      total,
      query.page,
      query.pageSize,
    );
  }

  async get(id: string) {
    const row = await this.deps.prisma.deadLetter.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Dead letter not found');
    return row;
  }

  /**
   * Re-publishes the original body directly to the original queue (default
   * exchange), not to the topic exchange — so only the consumer that failed
   * sees it again. Consumers are idempotent by envelope ID.
   */
  async replay(id: string, actorId: string) {
    const row = await this.get(id);
    if (row.status !== 'ARCHIVED')
      throw new ConflictError(`Dead letter is ${row.status}`, 'invalid_dead_letter_state');
    if (row.originalQueue === 'unknown')
      throw new ConflictError('Original queue unknown; cannot replay', 'unknown_queue');
    const headers: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row.headers as Record<string, string | number>)) {
      if (!FAILURE_HEADERS.has(key)) headers[key] = value;
    }
    headers[HEADERS.replayedFrom] = row.id;
    await this.deps.rabbit.publish('', row.originalQueue, Buffer.from(row.body, 'utf8'), {
      messageId: row.messageId,
      ...(row.eventType ? { type: row.eventType } : {}),
      ...(row.correlationId ? { correlationId: row.correlationId } : {}),
      headers,
    });
    replayed.inc({ queue: row.originalQueue });
    return this.deps.prisma.deadLetter.update({
      where: { id },
      data: {
        status: 'REPLAYED',
        replayCount: { increment: 1 },
        resolvedAt: new Date(),
        resolvedBy: actorId,
      },
    });
  }

  async discard(id: string, actorId: string) {
    const row = await this.get(id);
    if (row.status !== 'ARCHIVED')
      throw new ConflictError(`Dead letter is ${row.status}`, 'invalid_dead_letter_state');
    return this.deps.prisma.deadLetter.update({
      where: { id },
      data: { status: 'DISCARDED', resolvedAt: new Date(), resolvedBy: actorId },
    });
  }
}
