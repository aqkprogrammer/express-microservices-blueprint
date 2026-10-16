import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../apps/api-gateway/src/routes.js';
import { auditOpenApi } from '../../apps/audit-service/src/app.js';
import { authOpenApi } from '../../apps/auth-service/src/app.js';
import { inventoryOpenApi } from '../../apps/inventory-service/src/app.js';
import { notificationOpenApi } from '../../apps/notification-service/src/app.js';
import { orderOpenApi } from '../../apps/order-service/src/app.js';
import { paymentOpenApi } from '../../apps/payment-service/src/app.js';
import { productOpenApi } from '../../apps/product-service/src/app.js';
import { userOpenApi } from '../../apps/user-service/src/app.js';

const specs = {
  'auth-service': authOpenApi,
  'user-service': userOpenApi,
  'product-service': productOpenApi,
  'inventory-service': inventoryOpenApi,
  'order-service': orderOpenApi,
  'payment-service': paymentOpenApi,
  'notification-service': notificationOpenApi,
  'audit-service': auditOpenApi,
};

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Record<string, { responses: Record<string, unknown>; security?: unknown[] }>>;
}

describe('OpenAPI contracts', () => {
  for (const [service, build] of Object.entries(specs)) {
    describe(service, () => {
      const document = build() as OpenApiDoc;

      it('is a valid OpenAPI 3.1 document', async () => {
        expect(document.openapi).toBe('3.1.0');
        await expect(SwaggerParser.validate(structuredClone(document) as never)).resolves.toBeDefined();
      });

      it('documents only paths the public gateway actually routes (no internal endpoints)', () => {
        for (const path of Object.keys(document.paths)) {
          expect(path.startsWith('/internal'), path).toBe(false);
          expect(
            matchRoute(path.replace(/\{[^}]+\}/g, 'x')),
            `${path} is not routed by the gateway`,
          ).toBeDefined();
        }
      });

      it('declares error responses for every operation', () => {
        for (const [path, operations] of Object.entries(document.paths)) {
          for (const [method, operation] of Object.entries(operations)) {
            const statuses = Object.keys(operation.responses);
            expect(
              statuses.some((status) => status.startsWith('2')),
              `${method} ${path} has no success response`,
            ).toBe(true);
            if (operation.security)
              expect(statuses, `${method} ${path} is secured but omits 401`).toContain('401');
          }
        }
      });
    });
  }
});
