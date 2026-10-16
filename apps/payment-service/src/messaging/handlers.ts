import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type MessageConsumer } from '@emb/messaging';
import type { IdempotencyStore } from '../domain/idempotency.js';
import type { PaymentService } from '../domain/payment-service.js';

export function registerPaymentHandlers(
  consumer: MessageConsumer,
  service: PaymentService,
  idempotency: IdempotencyStore,
  db: SqlExecutor,
  logger: Logger,
): void {
  consumer
    // Deduplicated by payment state (one payment per order), not by message ID, so a
    // transient provider error can be retried through the retry queues.
    .on('PaymentAuthorizationRequested', ({ envelope }) =>
      service.handleAuthorizationRequested(envelope.payload),
    )
    .on('OrderConfirmed', ({ envelope }) => service.handleOrderConfirmed(envelope.id, envelope.payload))
    .on('OrderCancelled', ({ envelope }) => service.handleOrderCancelled(envelope.id, envelope.payload));
  const cleanup = cleanupTask(db, logger);
  registerMaintenance(
    consumer,
    {
      'payment.reconcile': async () => {
        await service.reconcile();
      },
      'all.cleanup': async () => {
        await cleanup();
        await idempotency.deleteOlderThan(new Date(Date.now() - 24 * 3_600_000));
      },
    },
    logger,
  );
}
