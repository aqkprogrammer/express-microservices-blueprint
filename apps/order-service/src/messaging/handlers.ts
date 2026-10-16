import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type MessageConsumer } from '@emb/messaging';
import type { OrderSaga } from '../domain/order-saga.js';

export function registerOrderHandlers(
  consumer: MessageConsumer,
  saga: OrderSaga,
  db: SqlExecutor,
  logger: Logger,
): void {
  consumer
    .on('InventoryReserved', ({ envelope }) => saga.onInventoryReserved(envelope.id, envelope.payload))
    .on('InventoryReservationFailed', ({ envelope }) =>
      saga.onInventoryReservationFailed(envelope.id, envelope.payload),
    )
    .on('InventoryReservationExpired', ({ envelope }) =>
      saga.onInventoryReservationExpired(envelope.id, envelope.payload),
    )
    .on('InventoryCommitFailed', ({ envelope }) =>
      saga.onInventoryCommitFailed(envelope.id, envelope.payload),
    )
    .on('PaymentAuthorized', ({ envelope }) => saga.onPaymentAuthorized(envelope.id, envelope.payload))
    .on('PaymentFailed', ({ envelope }) => saga.onPaymentFailed(envelope.id, envelope.payload));
  registerMaintenance(
    consumer,
    {
      'order.check-saga-timeouts': async () => {
        await saga.checkTimeouts();
      },
      'all.cleanup': cleanupTask(db, logger),
    },
    logger,
  );
}
