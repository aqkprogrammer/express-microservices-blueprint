import { ServiceClient } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { z } from 'zod';

const snapshotSchema = z.object({
  data: z.array(
    z.object({
      id: z.uuid(),
      sku: z.string(),
      name: z.string(),
      priceCents: z.number().int().nonnegative(),
      currency: z.string(),
      status: z.string(),
    }),
  ),
});
export type ProductSnapshot = z.infer<typeof snapshotSchema>['data'][number];

/** Synchronous read of authoritative prices from product-service (GET → safe to retry). */
export class ProductClient {
  private readonly client: ServiceClient;

  constructor(options: { baseUrl: string; internalToken: string; timeoutMs: number; logger: Logger }) {
    this.client = new ServiceClient({
      target: 'product-service',
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxRetries: 2,
      headers: { 'x-internal-token': options.internalToken },
      logger: options.logger,
    });
  }

  async getSnapshots(productIds: string[]): Promise<ProductSnapshot[]> {
    const response = await this.client.request({
      path: '/internal/v1/products',
      query: { ids: productIds.join(',') },
      schema: snapshotSchema,
    });
    return response.data;
  }
}
