import { currencySchema } from '@emb/contracts';
import { paginationQuerySchema } from '@emb/http-kit';
import { z } from 'zod';

export const PRODUCT_STATUSES = ['draft', 'active', 'discontinued'] as const;
export const productStatusSchema = z.enum(PRODUCT_STATUSES);

export const productSchema = z
  .object({
    id: z.uuid(),
    sku: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.string(),
    price: z.object({ amountCents: z.number().int(), currency: z.string() }),
    status: productStatusSchema,
    availability: z.object({
      availableQuantity: z.number().int(),
      inStock: z.boolean(),
      updatedAt: z.string().nullable(),
    }),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Product' });
export type ProductDto = z.infer<typeof productSchema>;

const skuSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, 'SKU must be 3-40 uppercase letters, digits or dashes');

export const createProductSchema = z
  .object({
    sku: skuSchema,
    name: z.string().trim().min(2).max(200),
    description: z.string().trim().max(5_000).default(''),
    category: z.string().trim().min(2).max(60),
    priceCents: z.number().int().min(0).max(100_000_000),
    currency: currencySchema.default('USD'),
    status: productStatusSchema.default('draft'),
  })
  .meta({ id: 'CreateProductRequest' });

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(5_000).optional(),
    category: z.string().trim().min(2).max(60).optional(),
    priceCents: z.number().int().min(0).max(100_000_000).optional(),
    status: productStatusSchema.optional(),
    /** Optimistic concurrency: reject the update if the product changed since it was read. */
    expectedVersion: z.number().int().positive().optional(),
  })
  .refine(
    (body) => Object.keys(body).some((key) => key !== 'expectedVersion'),
    'At least one field must be updated',
  )
  .meta({ id: 'UpdateProductRequest' });

export const PRODUCT_SORTS = ['newest', 'price', '-price', 'name', '-name'] as const;

export const listProductsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().max(60).optional(),
  status: productStatusSchema.optional(),
  minPriceCents: z.coerce.number().int().min(0).optional(),
  maxPriceCents: z.coerce.number().int().min(0).optional(),
  inStock: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  sort: z.enum(PRODUCT_SORTS).default('newest'),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

/** Status transitions allowed for admins; discontinued is terminal. */
export function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === 'draft') return to === 'active' || to === 'discontinued';
  if (from === 'active') return to === 'discontinued';
  return false;
}
