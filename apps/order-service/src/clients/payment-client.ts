import { ServiceClient, UpstreamError } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { z } from 'zod';
import type { PaymentLookup } from '../domain/order.js';

const paymentSchema = z.object({
  id: z.uuid(),
  orderId: z.uuid(),
  status: z.enum(['PENDING', 'PROCESSING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'VOIDED', 'REFUNDED']),
});

/** Used only for reconciliation when the payment step times out. */
export class PaymentClient {
  private readonly client: ServiceClient;

  constructor(options: { baseUrl: string; internalToken: string; timeoutMs: number; logger: Logger }) {
    this.client = new ServiceClient({
      target: 'payment-service',
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxRetries: 1,
      headers: { 'x-internal-token': options.internalToken },
      logger: options.logger,
    });
  }

  async lookupByOrder(orderId: string): Promise<PaymentLookup> {
    try {
      const payment = await this.client.request({
        path: `/internal/v1/payments/by-order/${orderId}`,
        schema: paymentSchema,
      });
      switch (payment.status) {
        case 'AUTHORIZED':
        case 'CAPTURED':
          return { status: payment.status, paymentId: payment.id };
        case 'FAILED':
          return { status: 'FAILED', paymentId: payment.id };
        case 'VOIDED':
        case 'REFUNDED':
          return { status: payment.status, paymentId: payment.id };
        default:
          return { status: 'PENDING', paymentId: payment.id };
      }
    } catch (error) {
      if (error instanceof UpstreamError && error.upstreamStatus === 404) return { status: 'NOT_FOUND' };
      throw error;
    }
  }
}
