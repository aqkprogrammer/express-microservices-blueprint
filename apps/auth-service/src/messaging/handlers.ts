import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type MessageConsumer } from '@emb/messaging';
import type { AuthService } from '../domain/auth-service.js';

export function registerAuthHandlers(
  consumer: MessageConsumer,
  service: AuthService,
  db: SqlExecutor,
  logger: Logger,
): void {
  consumer.on('UserStatusChanged', ({ envelope }) =>
    service.applyStatusChange(envelope.id, envelope.payload),
  );
  const cleanup = cleanupTask(db, logger, { outboxRetentionHours: 24 });
  registerMaintenance(
    consumer,
    {
      'all.cleanup': async () => {
        await cleanup();
        await service.deleteExpiredTokens();
      },
    },
    logger,
  );
}
