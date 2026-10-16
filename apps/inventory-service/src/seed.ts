/**
 * Idempotent demo stock for the products seeded by product-service (same fixed
 * IDs). The limited-edition lamp has a single unit so the out-of-stock
 * compensation path is easy to demonstrate.
 */
import { randomUUID } from 'node:crypto';
import { createPgPool, createPrismaAdapter, enqueueEvent } from '@emb/database';
import { createLogger } from '@emb/logger';
import { PrismaClient } from './generated/prisma/client.js';

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
const DEMO_STOCK = [
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001', sku: 'KB-MECH-001', onHand: 120 },
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2002', sku: 'MS-ERGO-002', onHand: 200 },
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2003', sku: 'MN-4K-027', onHand: 40 },
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2004', sku: 'HD-NC-004', onHand: 75 },
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2005', sku: 'DK-USBC-005', onHand: 60 },
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2006', sku: 'CM-HD-006', onHand: 150 },
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2007', sku: 'LS-ALU-007', onHand: 300 },
  { productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2008', sku: 'LT-LIMIT-008', onHand: 1 },
];

const logger = createLogger({ service: 'inventory-service-seed', level: 'info' });

async function seed(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPgPool({ connectionString: url, name: 'inventory-seed', max: 2 });
  const prisma = new PrismaClient({ adapter: createPrismaAdapter(pool) });
  let stocked = 0;
  try {
    for (const item of DEMO_STOCK) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO inventory_items (product_id, sku, updated_at) VALUES (${item.productId}::uuid, ${item.sku}, now())
          ON CONFLICT (product_id) DO NOTHING`;
        // Only stock items that have never been adjusted, so re-running the seed changes nothing.
        const adjusted = await tx.stockAdjustment.count({ where: { productId: item.productId } });
        if (adjusted > 0) return;
        const updated = await tx.inventoryItem.update({
          where: { productId: item.productId },
          data: { onHand: { increment: item.onHand }, version: { increment: 1 } },
        });
        await tx.stockAdjustment.create({
          data: {
            id: randomUUID(),
            productId: item.productId,
            delta: item.onHand,
            reason: 'demo seed',
            actorId: SYSTEM_ACTOR,
          },
        });
        await enqueueEvent(
          tx,
          'InventoryStockChanged',
          {
            productId: item.productId,
            onHand: updated.onHand,
            reserved: updated.reserved,
            available: updated.onHand - updated.reserved,
          },
          {
            producer: 'inventory-service',
            aggregateType: 'inventory_item',
            aggregateId: item.productId,
            correlationId: 'seed',
          },
        );
        stocked += 1;
      });
    }
    logger.info({ stocked, total: DEMO_STOCK.length }, 'inventory seed complete');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

await seed();
