import type { SqlExecutor } from '@emb/database';
import type { Logger } from '@emb/logger';
import { cleanupTask, registerMaintenance, type MessageConsumer } from '@emb/messaging';
import type { ProductService } from '../domain/product-service.js';

export function registerProductHandlers(
  consumer: MessageConsumer,
  service: ProductService,
  db: SqlExecutor,
  logger: Logger,
): void {
  consumer.on('InventoryStockChanged', async ({ envelope }) => {
    const { productId, available } = envelope.payload;
    const applied = await service.applyStockChange(
      envelope.id,
      productId,
      available,
      new Date(envelope.occurredAt),
    );
    logger.debug({ productId, available, applied }, 'availability read model updated');
  });
  registerMaintenance(consumer, { 'all.cleanup': cleanupTask(db, logger) }, logger);
}
