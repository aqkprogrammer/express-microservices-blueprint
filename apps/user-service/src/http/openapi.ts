import {
  buildOpenApiDocument,
  createOpenApiRegistry,
  paginatedResponseSchema,
  problemResponses,
} from '@emb/http-kit';
import {
  adminProfileSchema,
  changeStatusSchema,
  listUsersQuerySchema,
  profileSchema,
  updateProfileSchema,
  userIdParams,
} from '../domain/profile.js';

export function userOpenApi(): object {
  const registry = createOpenApiRegistry();
  const security = [{ bearerAuth: [] }];
  const json = <T>(schema: T) => ({ 'application/json': { schema } });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/users/me',
    tags: ['Users'],
    security,
    summary: 'Current user profile',
    responses: {
      200: { description: 'Profile', content: json(profileSchema) },
      ...problemResponses(401, 404),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/v1/users/me',
    tags: ['Users'],
    security,
    summary: 'Update own profile (display name, locale, marketing preference)',
    request: { body: { content: json(updateProfileSchema) } },
    responses: {
      200: { description: 'Profile', content: json(profileSchema) },
      ...problemResponses(400, 401, 404, 409),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/users',
    tags: ['Users (admin)'],
    security,
    summary: 'Search and filter users',
    request: { query: listUsersQuerySchema },
    responses: {
      200: { description: 'Users page', content: json(paginatedResponseSchema(adminProfileSchema)) },
      ...problemResponses(400, 401, 403),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/users/{userId}',
    tags: ['Users'],
    security,
    summary: 'Profile by ID (self or admin)',
    request: { params: userIdParams },
    responses: {
      200: { description: 'Profile', content: json(adminProfileSchema) },
      ...problemResponses(401, 403, 404),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/v1/users/{userId}/status',
    tags: ['Users (admin)'],
    security,
    summary: 'Suspend, reactivate or close an account (revokes sessions via UserStatusChanged)',
    request: { params: userIdParams, body: { content: json(changeStatusSchema) } },
    responses: {
      200: { description: 'Updated profile', content: json(adminProfileSchema) },
      ...problemResponses(400, 401, 403, 404, 422),
    },
  });
  return buildOpenApiDocument(registry, {
    title: 'User Service API',
    version: '1.0.0',
    description: 'User profiles and account status management.',
  });
}
