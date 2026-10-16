import {
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
  outboxBacklog,
  type OutboxRow,
  type SqlExecutor,
} from '@emb/database';
import type { Logger } from '@emb/logger';
import { serializeError } from '@emb/logger';
import {
  SpanKind,
  counter,
  extractTraceContext,
  gauge,
  injectTraceHeaders,
  withSpan,
} from '@emb/observability';
import type { RabbitMQClient } from './connection.js';
import { HEADERS } from './headers.js';

const relayed = counter('outbox_events_relayed_total', 'Outbox rows processed by the relay', ['outcome']);
const pendingGauge = gauge('outbox_pending_events', 'Outbox rows not yet published');
const oldestGauge = gauge('outbox_oldest_pending_age_seconds', 'Age of the oldest unpublished outbox row');

export interface OutboxRelayOptions {
  db: SqlExecutor;
  client: RabbitMQClient;
  logger: Logger;
  batchSize?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxBackoffMs?: number;
}

/**
 * Publishes committed outbox rows to RabbitMQ. Each row is marked PUBLISHED
 * only after the broker confirms it; failures put the row back with
 * exponential backoff and the attempt count, so no event is silently lost.
 * Duplicates are possible (crash between confirm and mark) — consumers are
 * idempotent by envelope ID.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private lastBacklogCheck = 0;

  constructor(private readonly options: OutboxRelayOptions) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Wakes the relay immediately (call after committing a transaction that wrote events). */
  notify(): void {
    if (!this.stopped && !this.running) this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Runs one claim/publish cycle; exposed for tests. Returns the number of rows published. */
  async runOnce(): Promise<number> {
    const { db, client, logger } = this.options;
    if (!client.isConnected) return 0;
    const rows = await claimOutboxBatch(db, this.options.batchSize ?? 50, this.options.leaseMs ?? 30_000);
    let published = 0;
    for (const row of rows) {
      try {
        await this.publishRow(row);
        await markOutboxPublished(db, row.id);
        relayed.inc({ outcome: 'published' });
        published += 1;
      } catch (error) {
        const retryInMs = Math.min(
          this.options.maxBackoffMs ?? 60_000,
          500 * 2 ** Math.min(row.attempts, 10),
        );
        relayed.inc({ outcome: 'failed' });
        logger.warn(
          {
            err: serializeError(error),
            outboxId: row.id,
            eventType: row.event_type,
            attempts: row.attempts,
            retryInMs,
          },
          'outbox publish failed; will retry',
        );
        await markOutboxFailed(db, row.id, error instanceof Error ? error.message : String(error), retryInMs);
      }
    }
    await this.updateBacklogMetrics();
    return published;
  }

  private async publishRow(row: OutboxRow): Promise<void> {
    const envelope = (typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope) as {
      id: string;
      type: string;
      version: number;
      producer: string;
      correlationId: string;
      occurredAt: string;
    };
    const headers = row.headers ?? {};
    await withSpan(
      `${row.exchange} publish ${row.event_type}`,
      {
        kind: SpanKind.PRODUCER,
        parent: extractTraceContext(headers),
        attributes: {
          'messaging.system': 'rabbitmq',
          'messaging.destination.name': row.exchange,
          'messaging.rabbitmq.destination.routing_key': row.routing_key,
          'messaging.message.id': row.id,
        },
      },
      async () => {
        // Re-inject inside the producer span so consumers become its children.
        await this.options.client.publish(
          row.exchange,
          row.routing_key,
          Buffer.from(JSON.stringify(envelope)),
          {
            messageId: envelope.id,
            type: row.event_type,
            appId: envelope.producer,
            correlationId: envelope.correlationId,
            timestamp: Math.floor(new Date(envelope.occurredAt).getTime() / 1000),
            headers: injectTraceHeaders({ [HEADERS.correlationId]: envelope.correlationId }),
          },
        );
      },
    );
  }

  private async updateBacklogMetrics(): Promise<void> {
    if (Date.now() - this.lastBacklogCheck < 5_000) return;
    this.lastBacklogCheck = Date.now();
    const backlog = await outboxBacklog(this.options.db);
    pendingGauge.set(backlog.pending);
    oldestGauge.set(backlog.oldestAgeSeconds);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.running = this.runOnce()
        .then((published) => {
          // A full batch suggests more work is waiting; poll again immediately.
          this.running = undefined;
          this.schedule(
            published >= (this.options.batchSize ?? 50) ? 0 : (this.options.pollIntervalMs ?? 500),
          );
        })
        .catch((error: unknown) => {
          this.running = undefined;
          this.options.logger.error({ err: serializeError(error) }, 'outbox relay cycle failed');
          this.schedule(Math.max(this.options.pollIntervalMs ?? 500, 2_000));
        });
    }, delayMs);
  }
}
