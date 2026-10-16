import type { SqlExecutor } from './sql.js';

/**
 * Idempotent-consumer guard. Insert the message ID inside the same transaction
 * as the handler's side effects: if the insert conflicts the message was
 * already handled and the caller must skip; if the transaction rolls back the
 * marker disappears with it, so a retry processes the message again.
 *
 * @returns true when this is the first time `consumer` sees `messageId`.
 */
export async function markMessageProcessed(
  tx: SqlExecutor,
  consumer: string,
  messageId: string,
): Promise<boolean> {
  const inserted = await tx.$executeRawUnsafe(
    `INSERT INTO processed_messages (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    consumer,
    messageId,
  );
  return inserted === 1;
}

/**
 * Markers only need to outlive the broker's redelivery window. Deleting them
 * after the retention period bounds table growth.
 */
export async function deleteProcessedMessagesBefore(db: SqlExecutor, olderThan: Date): Promise<number> {
  return db.$executeRawUnsafe(
    `DELETE FROM processed_messages WHERE processed_at < $1::timestamptz`,
    olderThan,
  );
}
