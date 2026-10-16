import {
  MAINTENANCE_EVENT_TYPE,
  maintenanceRequestedSchema,
  type MaintenanceRequested,
  type MaintenanceTask,
} from '@emb/contracts';
import { deleteProcessedMessagesBefore, deletePublishedOutboxEvents, type SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import type { MessageConsumer } from './consumer.js';

export interface CleanupOptions {
  outboxRetentionHours?: number;
  processedMessageRetentionHours?: number;
}

/**
 * Routes scheduled maintenance commands to per-task handlers. Commands are
 * plain messages (not catalog events) and are safe to run more than once.
 */
export function registerMaintenance(
  consumer: MessageConsumer,
  handlers: Partial<Record<MaintenanceTask, (command: MaintenanceRequested) => Promise<void>>>,
  logger: Logger,
): void {
  consumer.onMessage(MAINTENANCE_EVENT_TYPE, 1, maintenanceRequestedSchema, async ({ envelope }) => {
    const handler = handlers[envelope.payload.task];
    if (!handler) {
      logger.debug({ task: envelope.payload.task }, 'maintenance task not handled by this service');
      return;
    }
    const started = Date.now();
    await handler(envelope.payload);
    logger.info(
      { task: envelope.payload.task, durationMs: Date.now() - started },
      'maintenance task completed',
    );
  });
}

/** Standard retention for the outbox and idempotency tables every service owns. */
export function cleanupTask(db: SqlExecutor, logger: Logger, options: CleanupOptions = {}) {
  return async () => {
    const now = Date.now();
    const outbox = await deletePublishedOutboxEvents(
      db,
      new Date(now - (options.outboxRetentionHours ?? 72) * 3_600_000),
    );
    const processed = await deleteProcessedMessagesBefore(
      db,
      new Date(now - (options.processedMessageRetentionHours ?? 168) * 3_600_000),
    );
    logger.info(
      { outboxDeleted: outbox, processedMessagesDeleted: processed },
      'retention cleanup completed',
    );
  };
}
