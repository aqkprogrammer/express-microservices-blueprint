import { randomUUID } from 'node:crypto';
import { enqueueEvent, isUniqueViolation, markMessageProcessed } from '@emb/database';
import { ConflictError, NotFoundError, UnprocessableError, paginated, type Paginated } from '@emb/http-kit';
import type { ProductCache } from '../cache/product-cache.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { canTransition, type ListProductsQuery, type ProductDto } from './product.js';
import type { z } from 'zod';
import type { createProductSchema, updateProductSchema } from './product.js';

const PRODUCER = 'product-service';

type ProductRow = Prisma.ProductGetPayload<object>;

export function toProductDto(row: ProductRow): ProductDto {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    category: row.category,
    price: { amountCents: row.priceCents, currency: row.currency },
    status: row.status as ProductDto['status'],
    availability: {
      availableQuantity: row.availableQuantity,
      inStock: row.availableQuantity > 0,
      updatedAt: row.availabilityUpdatedAt?.toISOString() ?? null,
    },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ProductServiceDeps {
  prisma: PrismaClient;
  cache: ProductCache;
  /** Wakes the outbox relay after a commit. */
  onEventsCommitted: () => void;
}

export class ProductService {
  constructor(private readonly deps: ProductServiceDeps) {}

  async create(input: z.output<typeof createProductSchema>): Promise<ProductDto> {
    const id = randomUUID();
    try {
      const row = await this.deps.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({ data: { id, ...input } });
        await enqueueEvent(
          tx,
          'ProductCreated',
          {
            productId: created.id,
            sku: created.sku,
            name: created.name,
            priceCents: created.priceCents,
            currency: created.currency,
            status: input.status,
          },
          { producer: PRODUCER, aggregateType: 'product', aggregateId: created.id },
        );
        return created;
      });
      this.deps.onEventsCommitted();
      await this.deps.cache.invalidateProduct(row.id);
      return toProductDto(row);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictError(`SKU ${input.sku} already exists`, 'duplicate_sku');
      throw error;
    }
  }

  async update(productId: string, input: z.output<typeof updateProductSchema>): Promise<ProductDto> {
    const { expectedVersion, ...changes } = input;
    const row = await this.deps.prisma.$transaction(async (tx) => {
      const current = await tx.product.findUnique({ where: { id: productId } });
      if (!current) throw new NotFoundError('Product not found');
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw new ConflictError('Product was modified by someone else; reload and retry', 'version_conflict');
      }
      if (changes.status && !canTransition(current.status, changes.status)) {
        throw new UnprocessableError(
          `Cannot change status from ${current.status} to ${changes.status}`,
          'invalid_status_transition',
        );
      }
      const changedFields = Object.entries(changes)
        .filter(([key, value]) => value !== undefined && current[key as keyof typeof current] !== value)
        .map(([key]) => key);
      if (changedFields.length === 0) return current;

      // Conditional update on version guards against concurrent writers between read and write.
      const updated = await tx.product.updateMany({
        where: { id: productId, version: current.version },
        data: { ...changes, version: { increment: 1 } },
      });
      if (updated.count !== 1)
        throw new ConflictError('Product was modified concurrently; retry', 'version_conflict');
      const next = await tx.product.findUniqueOrThrow({ where: { id: productId } });
      await enqueueEvent(
        tx,
        'ProductUpdated',
        {
          productId: next.id,
          sku: next.sku,
          name: next.name,
          priceCents: next.priceCents,
          currency: next.currency,
          status: next.status as ProductDto['status'],
          changedFields,
        },
        { producer: PRODUCER, aggregateType: 'product', aggregateId: next.id },
      );
      return next;
    });
    this.deps.onEventsCommitted();
    await this.deps.cache.invalidateProduct(productId);
    return toProductDto(row);
  }

  async get(productId: string, includeDrafts: boolean): Promise<ProductDto> {
    const load = async () => {
      const row = await this.deps.prisma.product.findUnique({ where: { id: productId } });
      return row ? toProductDto(row) : null;
    };
    // Drafts are admin-only and never cached for the public.
    const product = includeDrafts
      ? await load()
      : await this.deps.cache.getOrLoad('detail', this.deps.cache.detailKey(productId), load);
    if (!product || (!includeDrafts && product.status === 'draft'))
      throw new NotFoundError('Product not found');
    return product;
  }

  async list(query: ListProductsQuery, admin: boolean): Promise<Paginated<ProductDto>> {
    const effective = { ...query, status: admin ? query.status : 'active' };
    const load = () => this.query(effective);
    if (admin) return load();
    return this.deps.cache.getOrLoad('list', await this.deps.cache.listKey(effective), load);
  }

  private async query(query: ListProductsQuery): Promise<Paginated<ProductDto>> {
    const where: Prisma.ProductWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { sku: { equals: query.q.toUpperCase() } },
            ],
          }
        : {}),
      ...(query.minPriceCents !== undefined || query.maxPriceCents !== undefined
        ? { priceCents: { gte: query.minPriceCents, lte: query.maxPriceCents } }
        : {}),
      ...(query.inStock === undefined
        ? {}
        : query.inStock
          ? { availableQuantity: { gt: 0 } }
          : { availableQuantity: { equals: 0 } }),
    };
    const orderBy: Prisma.ProductOrderByWithRelationInput[] = {
      newest: [{ createdAt: 'desc' as const }],
      price: [{ priceCents: 'asc' as const }],
      '-price': [{ priceCents: 'desc' as const }],
      name: [{ name: 'asc' as const }],
      '-name': [{ name: 'desc' as const }],
    }[query.sort];
    // Stable tiebreaker so pagination never skips or repeats rows.
    orderBy.push({ id: 'asc' });
    const [rows, total] = await this.deps.prisma.$transaction([
      this.deps.prisma.product.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.deps.prisma.product.count({ where }),
    ]);
    return paginated(rows.map(toProductDto), total, query.page, query.pageSize);
  }

  /** Internal API for order-service price snapshots: always read from Postgres, never the cache. */
  async findForSnapshot(ids: string[]) {
    const rows = await this.deps.prisma.product.findMany({ where: { id: { in: ids } } });
    return rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      priceCents: row.priceCents,
      currency: row.currency,
      status: row.status,
    }));
  }

  /**
   * Applies an InventoryStockChanged event to the availability read model.
   * Out-of-order events are ignored by comparing the event timestamp.
   */
  async applyStockChange(
    messageId: string,
    productId: string,
    available: number,
    occurredAt: Date,
  ): Promise<boolean> {
    const applied = await this.deps.prisma.$transaction(async (tx) => {
      if (!(await markMessageProcessed(tx, 'product-service.stock-changed', messageId))) return false;
      const result = await tx.product.updateMany({
        where: {
          id: productId,
          OR: [{ availabilityUpdatedAt: null }, { availabilityUpdatedAt: { lt: occurredAt } }],
        },
        data: { availableQuantity: available, availabilityUpdatedAt: occurredAt },
      });
      return result.count === 1;
    });
    if (applied) await this.deps.cache.invalidateProduct(productId);
    return applied;
  }
}
