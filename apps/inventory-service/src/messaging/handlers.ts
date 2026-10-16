import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type MessageConsumer } from '@emb/messaging';
import type { InventoryService } from '../domain/inventory-service.js';

export function registerInventoryHandlers(
  consumer: MessageConsumer,
  service: InventoryService,
  db: SqlExecutor,
  logger: Logger,
): void {
  consumer
    .on('ProductCreated', ({ envelope }) => service.handleProductCreated(envelope.id, envelope.payload))
    .on('OrderCreated', ({ envelope }) => service.handleOrderCreated(envelope.id, envelope.payload))
    .on('OrderConfirmed', ({ envelope }) => service.handleOrderConfirmed(envelope.id, envelope.payload))
    .on('OrderCancelled', ({ envelope }) => service.handleOrderCancelled(envelope.id, envelope.payload));
  registerMaintenance(
    consumer,
    {
      'inventory.expire-reservations': async () => {
        await service.expireReservations();
      },
      'all.cleanup': cleanupTask(db, logger),
    },
    logger,
  );
}
