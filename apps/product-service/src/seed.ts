/**
 * Idempotent demo catalog. Product IDs are fixed so inventory-service's seed
 * can stock the same products; ProductCreated events are written through the
 * outbox only for rows that did not exist yet.
 */
import { enqueueEvent } from '@emb/database';
import { createPgPool, createPrismaAdapter } from '@emb/database';
import { createLogger } from '@emb/logger';
import { PrismaClient } from './generated/prisma/client.js';

export const DEMO_PRODUCTS = [
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001',
    sku: 'KB-MECH-001',
    name: 'Mechanical Keyboard',
    category: 'peripherals',
    priceCents: 12_900,
  },
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2002',
    sku: 'MS-ERGO-002',
    name: 'Ergonomic Mouse',
    category: 'peripherals',
    priceCents: 5_900,
  },
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2003',
    sku: 'MN-4K-027',
    name: '27" 4K Monitor',
    category: 'displays',
    priceCents: 42_900,
  },
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2004',
    sku: 'HD-NC-004',
    name: 'Noise-Cancelling Headphones',
    category: 'audio',
    priceCents: 24_900,
  },
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2005',
    sku: 'DK-USBC-005',
    name: 'USB-C Docking Station',
    category: 'accessories',
    priceCents: 18_900,
  },
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2006',
    sku: 'CM-HD-006',
    name: 'HD Webcam',
    category: 'peripherals',
    priceCents: 7_900,
  },
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2007',
    sku: 'LS-ALU-007',
    name: 'Aluminium Laptop Stand',
    category: 'accessories',
    priceCents: 3_900,
  },
  {
    id: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2008',
    sku: 'LT-LIMIT-008',
    name: 'Limited Edition Desk Lamp',
    category: 'accessories',
    priceCents: 9_900,
  },
] as const;

const logger = createLogger({ service: 'product-service-seed', level: 'info' });

async function seed(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPgPool({ connectionString: url, name: 'product-seed', max: 2 });
  const prisma = new PrismaClient({ adapter: createPrismaAdapter(pool) });
  let created = 0;
  try {
    for (const product of DEMO_PRODUCTS) {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.product.findUnique({ where: { id: product.id } });
        if (existing) return;
        await tx.product.create({
          data: {
            ...product,
            currency: 'USD',
            status: 'active',
            description: `Demo product: ${product.name}`,
          },
        });
        await enqueueEvent(
          tx,
          'ProductCreated',
          {
            productId: product.id,
            sku: product.sku,
            name: product.name,
            priceCents: product.priceCents,
            currency: 'USD',
            status: 'active',
          },
          {
            producer: 'product-service',
            aggregateType: 'product',
            aggregateId: product.id,
            correlationId: 'seed',
          },
        );
        created += 1;
      });
    }
    logger.info({ created, total: DEMO_PRODUCTS.length }, 'product seed complete');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

await seed();
