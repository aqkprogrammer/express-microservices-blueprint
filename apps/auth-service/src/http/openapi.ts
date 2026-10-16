import { buildOpenApiDocument, createOpenApiRegistry, problemResponses } from '@emb/http-kit';
import { z } from 'zod';
import {
  loginSchema,
  meSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshSchema,
  registerSchema,
  tokenPairSchema,
} from './schemas.js';

export function authOpenApi(): object {
  const registry = createOpenApiRegistry();
  const json = <T>(schema: T) => ({ 'application/json': { schema } });
  const tags = ['Authentication'];
  const tokens = {
    description: 'Access token + rotated refresh token (also set as an HttpOnly cookie)',
    content: json(tokenPairSchema),
  };

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/register',
    tags,
    summary: 'Create an account',
    request: { body: { content: json(registerSchema) } },
    responses: { 201: tokens, ...problemResponses(400, 409, 429) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags,
    summary: 'Log in with email and password',
    request: { body: { content: json(loginSchema) } },
    responses: { 200: tokens, ...problemResponses(400, 401, 429) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/refresh',
    tags,
    summary: 'Rotate the refresh token. Replaying an old token revokes the session.',
    request: { body: { content: json(refreshSchema) } },
    responses: { 200: tokens, ...problemResponses(400, 401) },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout',
    tags,
    summary: 'Revoke the current session',
    request: { body: { content: json(refreshSchema) } },
    responses: { 204: { description: 'Logged out' } },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/password-reset/request',
    tags,
    summary: 'Request a password-reset email (always 202)',
    request: { body: { content: json(passwordResetRequestSchema) } },
    responses: {
      202: { description: 'Accepted', content: json(z.object({ message: z.string() })) },
      ...problemResponses(400, 429),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/password-reset/confirm',
    tags,
    summary: 'Set a new password with a single-use reset token; revokes all sessions',
    request: { body: { content: json(passwordResetConfirmSchema) } },
    responses: { 204: { description: 'Password changed' }, ...problemResponses(400) },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/me',
    tags,
    security: [{ bearerAuth: [] }],
    summary: 'Claims of the current access token',
    responses: { 200: { description: 'Current user', content: json(meSchema) }, ...problemResponses(401) },
  });
  return buildOpenApiDocument(registry, {
    title: 'Auth Service API',
    version: '1.0.0',
    description:
      'Reference authentication implementation (ES256 JWT access tokens, rotating refresh tokens). See docs/security/authentication.md for limitations and when to prefer an identity provider.',
  });
}
