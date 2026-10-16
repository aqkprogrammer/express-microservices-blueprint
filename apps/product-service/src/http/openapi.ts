import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  paginatedResponseSchema,
  problemResponses,
} from '@emb/http-kit';
import {
  createProductSchema,
  listProductsQuerySchema,
  productSchema,
  updateProductSchema,
} from '../domain/product.js';
import { productIdParams } from './routes.js';

export function productOpenApi(): object {
  const registry = createOpenApiRegistry();
  registry.register('Product', productSchema);
  const bearer = [{ bearerAuth: [] }];

  registry.registerPath({
    method: 'get',
    path: '/api/v1/products',
    tags: ['Products'],
    summary: 'List and search the catalog (public). Cached in Redis.',
    description:
      'Anonymous callers only see active products. Admins may filter by status. Results are cache-aside cached for ~60s and invalidated on catalog changes.',
    request: { query: listProductsQuerySchema },
    responses: {
      200: {
        description: 'A page of products',
        content: { 'application/json': { schema: paginatedResponseSchema(productSchema) } },
      },
      ...problemResponses(400),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/products/{productId}',
    tags: ['Products'],
    summary: 'Product details (public)',
    request: { params: productIdParams },
    responses: {
      200: { description: 'The product', content: { 'application/json': { schema: productSchema } } },
      ...problemResponses(400, 404),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/products',
    tags: ['Products (admin)'],
    summary: 'Create a product',
    security: bearer,
    request: { body: { content: { 'application/json': { schema: createProductSchema } } } },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: productSchema } } },
      ...problemResponses(400, 401, 403, 409),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/v1/products/{productId}',
    tags: ['Products (admin)'],
    summary: 'Update a product (optimistic concurrency via expectedVersion)',
    security: bearer,
    request: {
      params: productIdParams,
      body: { content: { 'application/json': { schema: updateProductSchema } } },
    },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: productSchema } } },
      ...problemResponses(400, 401, 403, 404, 409, 422),
    },
  });
  return buildOpenApiDocument(registry, {
    title: 'Product Service API',
    version: '1.0.0',
    description:
      'Catalog listing, search, details and admin management. Internal `/internal/*` routes are not exposed.',
  });
}
