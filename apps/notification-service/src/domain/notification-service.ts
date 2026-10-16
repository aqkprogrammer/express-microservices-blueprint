import { randomUUID } from 'node:crypto';
import type { EventPayload } from '@emb/contracts';
import { enqueueEvent, isUniqueViolation, markMessageProcessed } from '@emb/database';
import { ConflictError, NotFoundError, UnprocessableError, paginated } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { NonRetryableError } from '@emb/messaging';
import { counter } from '@emb/observability';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { EmailTransport } from '../transport/email-transport.js';
import {
  DEFAULT_TEMPLATES,
  MissingTemplateVariableError,
  cancellationText,
  formatMoney,
  orderReference,
  placeholders,
  render,
} from './templates.js';

const PRODUCER = 'notification-service';
const deliveries = counter('notifications_delivered_total', 'Notification delivery attempts by outcome', [
  'template',
  'outcome',
]);

export class RecipientNotFoundError extends Error {
  constructor(userId: string) {
    super(`No recipient record for user ${userId} yet`);
    this.name = 'RecipientNotFoundError';
  }
}

export interface DeliveryRequest {
  sourceEventId: string;
  recipientUserId: string;
  template: string;
  data: Record<string, string | number>;
  sensitiveKeys?: string[];
  /** True when this is the last delivery attempt the consumer will make. */
  finalAttempt: boolean;
}

type NotificationRow = Prisma.NotificationGetPayload<object>;

const toDto = (row: NotificationRow) => ({
  id: row.id,
  recipientUserId: row.recipientUserId,
  template: row.template,
  channel: row.channel,
  status: row.status,
  attempts: row.attempts,
  lastError: row.lastError,
  sentAt: row.sentAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export class NotificationService {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      transport: EmailTransport;
      logger: Logger;
      onEventsCommitted: () => void;
    },
  ) {}

  /** Inserts default templates that do not exist yet; never overwrites admin edits. */
  async ensureDefaultTemplates(): Promise<void> {
    for (const [key, template] of Object.entries(DEFAULT_TEMPLATES)) {
      await this.deps.prisma.notificationTemplate.upsert({
        where: { key },
        create: { key, ...template },
        update: {},
      });
    }
  }

  // ── Recipient read model ───────────────────────────────────────────────────

  async upsertRecipient(
    messageId: string,
    userId: string,
    email: string,
    displayName: string,
  ): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      if (!(await markMessageProcessed(tx, 'notification.recipient', messageId))) return;
      await tx.recipient.upsert({
        where: { userId },
        create: { userId, email, displayName },
        update: { email, displayName },
      });
    });
  }

  // ── Event → notification mapping ───────────────────────────────────────────

  onUserRegistered(id: string, p: EventPayload<'UserRegistered'>, finalAttempt: boolean) {
    return this.deliver({
      sourceEventId: id,
      recipientUserId: p.userId,
      template: 'welcome',
      data: {},
      finalAttempt,
    });
  }

  onOrderConfirmed(id: string, p: EventPayload<'OrderConfirmed'>, finalAttempt: boolean) {
    return this.deliver({
      sourceEventId: id,
      recipientUserId: p.customerId,
      template: 'order-confirmed',
      data: {
        orderReference: orderReference(p.orderId),
        itemCount: p.lines.reduce((sum, line) => sum + line.quantity, 0),
        total: formatMoney(p.totalCents, p.currency),
      },
      finalAttempt,
    });
  }

  onOrderCancelled(id: string, p: EventPayload<'OrderCancelled'>, finalAttempt: boolean) {
    return this.deliver({
      sourceEventId: id,
      recipientUserId: p.customerId,
      template: 'order-cancelled',
      data: { orderReference: orderReference(p.orderId), reason: cancellationText(p.reason) },
      finalAttempt,
    });
  }

  onOrderRequiresReview(id: string, p: EventPayload<'OrderRequiresReview'>, finalAttempt: boolean) {
    return this.deliver({
      sourceEventId: id,
      recipientUserId: p.customerId,
      template: 'order-under-review',
      data: { orderReference: orderReference(p.orderId) },
      finalAttempt,
    });
  }

  onPaymentRefunded(id: string, p: EventPayload<'PaymentRefunded'>, finalAttempt: boolean) {
    return this.deliver({
      sourceEventId: id,
      recipientUserId: p.customerId,
      template: 'payment-refunded',
      data: { orderReference: orderReference(p.orderId), amount: formatMoney(p.amountCents, p.currency) },
      finalAttempt,
    });
  }

  onNotificationRequested(id: string, p: EventPayload<'NotificationRequested'>, finalAttempt: boolean) {
    return this.deliver({
      sourceEventId: id,
      recipientUserId: p.recipientUserId,
      template: p.template,
      data: p.data,
      sensitiveKeys: p.sensitiveDataKeys,
      finalAttempt,
    });
  }

  /**
   * Idempotent delivery: one notification row per (source event, template).
   * A row that is already SENT is never sent again. Failures are recorded and
   * re-thrown so the consumer retries with backoff; on the final attempt the
   * row is marked FAILED and NotificationDeliveryFailed is published before
   * the message goes to the dead-letter exchange.
   */
  async deliver(request: DeliveryRequest): Promise<void> {
    const notification = await this.findOrCreate(request);
    if (notification.status === 'SENT') return;

    try {
      const recipient = await this.deps.prisma.recipient.findUnique({
        where: { userId: request.recipientUserId },
      });
      // Recipient events may not have been processed yet (eventual consistency) — retryable.
      if (!recipient) throw new RecipientNotFoundError(request.recipientUserId);
      const template = await this.deps.prisma.notificationTemplate.findUnique({
        where: { key: request.template },
      });
      if (!template) throw new NonRetryableError(`Unknown template ${request.template}`);
      const data = {
        displayName: recipient.displayName,
        ...(notification.data as Record<string, string | number>),
      };
      let subject: string;
      let text: string;
      try {
        subject = render(template.subject, data);
        text = render(template.bodyText, data);
      } catch (error) {
        if (error instanceof MissingTemplateVariableError)
          throw new NonRetryableError(error.message, { cause: error });
        throw error;
      }
      await this.deps.transport.send({ to: recipient.email, subject, text });
      await this.deps.prisma.$transaction(async (tx) => {
        await tx.notification.update({
          where: { id: notification.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            attempts: { increment: 1 },
            lastError: null,
            data: scrub(notification),
          },
        });
        await enqueueEvent(
          tx,
          'NotificationSent',
          {
            notificationId: notification.id,
            template: request.template,
            recipientUserId: request.recipientUserId,
          },
          { producer: PRODUCER, aggregateType: 'notification', aggregateId: notification.id },
        );
      });
      deliveries.inc({ template: request.template, outcome: 'sent' });
      this.deps.onEventsCommitted();
    } catch (error) {
      const permanent = error instanceof NonRetryableError || request.finalAttempt;
      await this.deps.prisma.$transaction(async (tx) => {
        const updated = await tx.notification.update({
          where: { id: notification.id },
          data: {
            attempts: { increment: 1 },
            lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
            ...(permanent ? { status: 'FAILED', data: scrub(notification) } : {}),
          },
        });
        if (permanent) {
          await enqueueEvent(
            tx,
            'NotificationDeliveryFailed',
            {
              notificationId: notification.id,
              template: request.template,
              recipientUserId: request.recipientUserId,
              attempts: updated.attempts,
            },
            { producer: PRODUCER, aggregateType: 'notification', aggregateId: notification.id },
          );
        }
      });
      deliveries.inc({ template: request.template, outcome: permanent ? 'failed' : 'retry' });
      if (permanent) this.deps.onEventsCommitted();
      throw error;
    }
  }

  private async findOrCreate(request: DeliveryRequest): Promise<NotificationRow> {
    const where = {
      sourceEventId_template: { sourceEventId: request.sourceEventId, template: request.template },
    };
    const existing = await this.deps.prisma.notification.findUnique({ where });
    if (existing) return existing;
    try {
      return await this.deps.prisma.notification.create({
        data: {
          id: randomUUID(),
          sourceEventId: request.sourceEventId,
          recipientUserId: request.recipientUserId,
          template: request.template,
          data: request.data,
          sensitiveKeys: request.sensitiveKeys ?? [],
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return this.deps.prisma.notification.findUniqueOrThrow({ where });
      throw error;
    }
  }

  // ── Admin & user API ───────────────────────────────────────────────────────

  async list(query: {
    page: number;
    pageSize: number;
    status?: string | undefined;
    recipientUserId?: string | undefined;
  }) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.recipientUserId ? { recipientUserId: query.recipientUserId } : {}),
    };
    const [rows, total] = await this.deps.prisma.$transaction([
      this.deps.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.deps.prisma.notification.count({ where }),
    ]);
    return paginated(rows.map(toDto), total, query.page, query.pageSize);
  }

  async listTemplates() {
    const rows = await this.deps.prisma.notificationTemplate.findMany({ orderBy: { key: 'asc' } });
    return rows.map((row) => ({
      key: row.key,
      channel: row.channel,
      subject: row.subject,
      bodyText: row.bodyText,
      version: row.version,
      placeholders: [...new Set([...placeholders(row.subject), ...placeholders(row.bodyText)])],
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Versioned template edit with optimistic concurrency; placeholders must stay a subset of the defaults'. */
  async updateTemplate(
    key: string,
    input: { subject: string; bodyText: string; expectedVersion: number },
    actorId: string,
  ) {
    const current = await this.deps.prisma.notificationTemplate.findUnique({ where: { key } });
    if (!current) throw new NotFoundError('Template not found');
    const allowed = new Set([
      'displayName',
      ...placeholders(DEFAULT_TEMPLATES[key]?.subject ?? current.subject),
      ...placeholders(DEFAULT_TEMPLATES[key]?.bodyText ?? current.bodyText),
    ]);
    const unknown = [...placeholders(input.subject), ...placeholders(input.bodyText)].filter(
      (name) => !allowed.has(name),
    );
    if (unknown.length > 0)
      throw new UnprocessableError(
        `Unknown placeholders: ${[...new Set(unknown)].join(', ')}`,
        'unknown_placeholder',
      );
    const updated = await this.deps.prisma.notificationTemplate.updateMany({
      where: { key, version: input.expectedVersion },
      data: {
        subject: input.subject,
        bodyText: input.bodyText,
        version: { increment: 1 },
        updatedBy: actorId,
      },
    });
    if (updated.count !== 1)
      throw new ConflictError('Template was modified concurrently; reload and retry', 'version_conflict');
    return (await this.listTemplates()).find((template) => template.key === key);
  }
}

/** Removes sensitive values (e.g. password-reset links) once they are no longer needed. */
function scrub(notification: NotificationRow): Prisma.InputJsonValue {
  const data = { ...(notification.data as Record<string, unknown>) };
  for (const key of notification.sensitiveKeys) if (key in data) data[key] = '[scrubbed]';
  return data as Prisma.InputJsonValue;
}
