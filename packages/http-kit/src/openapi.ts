import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
  type ResponseConfig,
} from '@asteasolutions/zod-to-openapi';
import { problemDetailsSchema } from '@emb/contracts';
import { z } from 'zod';

// Adds `.openapi()` to Zod schemas; required by `registry.register`. Schemas
// otherwise carry their component names via Zod's native `.meta({ id })`.
extendZodWithOpenApi(z);

export function createOpenApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.register('ProblemDetails', problemDetailsSchema.meta({ id: 'ProblemDetails' }));
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  return registry;
}

const problem = (description: string): ResponseConfig => ({
  description,
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
});

/** Standard error responses, merged into each operation's `responses`. */
export function problemResponses(...statuses: number[]): Record<string, ResponseConfig> {
  const descriptions: Record<number, string> = {
    400: 'Validation failed',
    401: 'Missing or invalid access token',
    403: 'Authenticated but not allowed',
    404: 'Resource not found',
    409: 'Conflict with current state',
    422: 'Request understood but cannot be processed',
    429: 'Rate limit exceeded',
    503: 'Dependency unavailable',
  };
  return Object.fromEntries(
    statuses.map((status) => [String(status), problem(descriptions[status] ?? 'Error')]),
  );
}

export function buildOpenApiDocument(
  registry: OpenAPIRegistry,
  info: { title: string; version: string; description: string },
): object {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { ...info, license: { name: 'MIT', identifier: 'MIT' } },
    servers: [{ url: 'http://localhost:8080', description: 'Local API gateway' }],
  });
}
