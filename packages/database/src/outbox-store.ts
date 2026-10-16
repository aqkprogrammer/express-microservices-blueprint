import type { SqlExecutor } from './sql.js';

export interface OutboxRow {
  id: string;
  event_type: string;
  exchange: string;
  routing_key: string;
  envelope: unknown;
  headers: Record<string, string>;
  attempts: number;
}

/**
 * Claims up to `limit` publishable rows by leasing them for `leaseMs`.
 * `FOR UPDATE SKIP LOCKED` lets several relay instances run concurrently
 * without blocking or double-claiming; a crashed relay's lease simply expires
 * and the rows are claimed again (at-least-once publication).
 */
export async function claimOutboxBatch(
  db: SqlExecutor,
  limit: number,
  leaseMs: number,
): Promise<OutboxRow[]> {
  return db.$queryRawUnsafe<OutboxRow[]>(
    `UPDATE outbox_events
        SET status = 'PUBLISHING',
            locked_until = now() + ($2::int * interval '1 millisecond'),
            attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE (status = 'PENDING' AND available_at <= now())
            OR (status = 'PUBLISHING' AND locked_until < now())
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
      RETURNING id::text, event_type, exchange, routing_key, envelope, headers, attempts`,
    limit,
    leaseMs,
  );
}

export async function markOutboxPublished(db: SqlExecutor, id: string): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE outbox_events
        SET status = 'PUBLISHED', published_at = now(), locked_until = NULL, last_error = NULL
      WHERE id = $1::uuid`,
    id,
  );
}

/** Returns the row to PENDING with a delayed `available_at`; rows are never dropped. */
export async function markOutboxFailed(
  db: SqlExecutor,
  id: string,
  error: string,
  retryInMs: number,
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE outbox_events
        SET status = 'PENDING',
            locked_until = NULL,
            last_error = $2,
            available_at = now() + ($3::int * interval '1 millisecond')
      WHERE id = $1::uuid`,
    id,
    error.slice(0, 1_000),
    retryInMs,
  );
}

export async function outboxBacklog(db: SqlExecutor): Promise<{ pending: number; oldestAgeSeconds: number }> {
  const rows = await db.$queryRawUnsafe<{ pending: number; oldest_age_seconds: number | null }[]>(
    `SELECT count(*)::int AS pending,
            EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 AS oldest_age_seconds
       FROM outbox_events
      WHERE status <> 'PUBLISHED'`,
  );
  const row = rows[0];
  return { pending: row?.pending ?? 0, oldestAgeSeconds: row?.oldest_age_seconds ?? 0 };
}

/** Retention: published rows are kept for audit/debugging, then deleted. */
export async function deletePublishedOutboxEvents(db: SqlExecutor, olderThan: Date): Promise<number> {
  return db.$executeRawUnsafe(
    `DELETE FROM outbox_events WHERE status = 'PUBLISHED' AND published_at < $1::timestamptz`,
    olderThan,
  );
}
