import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type MessageConsumer } from '@emb/messaging';
import type { UserService } from '../domain/user-service.js';

export function registerUserHandlers(
  consumer: MessageConsumer,
  service: UserService,
  db: SqlExecutor,
  logger: Logger,
): void {
  consumer.on('UserRegistered', ({ envelope }) =>
    service.createFromRegistration(envelope.id, envelope.payload),
  );
  registerMaintenance(consumer, { 'all.cleanup': cleanupTask(db, logger) }, logger);
}
