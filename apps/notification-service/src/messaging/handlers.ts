import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type ConsumedMessage, type MessageConsumer } from '@emb/messaging';
import type { NotificationService } from '../domain/notification-service.js';

export function registerNotificationHandlers(
  consumer: MessageConsumer,
  service: NotificationService,
  retries: number,
  db: SqlExecutor,
  logger: Logger,
): void {
  const final = (message: ConsumedMessage) => message.attempt >= retries;
  consumer
    .on('UserRegistered', async (message) => {
      const { userId, email, displayName } = message.envelope.payload;
      await service.upsertRecipient(message.envelope.id, userId, email, displayName);
      await service.onUserRegistered(message.envelope.id, message.envelope.payload, final(message));
    })
    .on('UserProfileUpdated', ({ envelope }) =>
      service.upsertRecipient(
        envelope.id,
        envelope.payload.userId,
        envelope.payload.email,
        envelope.payload.displayName,
      ),
    )
    .on('OrderConfirmed', (m) => service.onOrderConfirmed(m.envelope.id, m.envelope.payload, final(m)))
    .on('OrderCancelled', (m) => service.onOrderCancelled(m.envelope.id, m.envelope.payload, final(m)))
    .on('OrderRequiresReview', (m) =>
      service.onOrderRequiresReview(m.envelope.id, m.envelope.payload, final(m)),
    )
    .on('PaymentRefunded', (m) => service.onPaymentRefunded(m.envelope.id, m.envelope.payload, final(m)))
    .on('NotificationRequested', (m) =>
      service.onNotificationRequested(m.envelope.id, m.envelope.payload, final(m)),
    );
  registerMaintenance(consumer, { 'all.cleanup': cleanupTask(db, logger) }, logger);
}
