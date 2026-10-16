import { parseWith } from '@emb/http-kit';
import {
  assertOwnerOrAdmin,
  authenticate,
  isAdmin,
  principal,
  requireRoles,
  type AccessTokenVerifier,
} from '@emb/security';
import { Router } from 'express';
import {
  changeStatusSchema,
  listUsersQuerySchema,
  updateProfileSchema,
  userIdParams,
} from '../domain/profile.js';
import type { UserService } from '../domain/user-service.js';

export function userRoutes(deps: { service: UserService; verifier: AccessTokenVerifier }): Router {
  const router = Router();
  const { service } = deps;
  router.use('/api/v1/users', authenticate(deps.verifier));

  router.get('/api/v1/users/me', async (req, res) => {
    res.json(await service.getProfile(principal(req).userId));
  });

  router.patch('/api/v1/users/me', async (req, res) => {
    res.json(await service.updateProfile(principal(req).userId, parseWith(updateProfileSchema, req.body)));
  });

  router.get('/api/v1/users', requireRoles('admin'), async (req, res) => {
    res.json(await service.list(parseWith(listUsersQuerySchema, req.query, 'query')));
  });

  router.get('/api/v1/users/:userId', async (req, res) => {
    const { userId } = parseWith(userIdParams, req.params, 'params');
    assertOwnerOrAdmin(principal(req), userId);
    res.json(isAdmin(req) ? await service.getForAdmin(userId) : await service.getProfile(userId));
  });

  router.patch('/api/v1/users/:userId/status', requireRoles('admin'), async (req, res) => {
    const { userId } = parseWith(userIdParams, req.params, 'params');
    const { status, reason } = parseWith(changeStatusSchema, req.body);
    res.json(await service.changeStatus(userId, status, reason, principal(req).userId));
  });

  return router;
}
