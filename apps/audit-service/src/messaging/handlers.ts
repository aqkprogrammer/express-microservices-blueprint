import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type MessageConsumer } from '@emb/messaging';
import type { AuditService } from '../domain/audit-service.js';

export function registerAuditHandlers(
  consumer: MessageConsumer,
  service: AuditService,
  retentionDays: number,
  db: SqlExecutor,
  logger: Logger,
): void {
  registerMaintenance(
    consumer,
    {
      'audit.apply-retention': async () => {
        await service.applyRetention(retentionDays);
      },
      'all.cleanup': cleanupTask(db, logger),
    },
    logger,
  );
  // Every other event bound to the audit queue (validated against the catalog) is recorded.
  consumer.onAny(({ envelope }) => service.record(envelope));
}
