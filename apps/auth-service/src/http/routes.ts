import { UnauthorizedError, parseWith } from '@emb/http-kit';
import { authenticate, principal, type AccessTokenVerifier } from '@emb/security';
import { Router, type Response } from 'express';
import type { AuthService, TokenPair } from '../domain/auth-service.js';
import type { SigningMaterial } from '../domain/tokens.js';
import { REFRESH_COOKIE, clearRefreshCookie, readCookie, refreshCookieOptions } from './cookies.js';
import {
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshSchema,
  registerSchema,
} from './schemas.js';

export interface AuthRouteDeps {
  service: AuthService;
  verifier: AccessTokenVerifier;
  signing: SigningMaterial;
  cookieSecure: boolean;
  refreshTokenTtlSeconds: number;
}

export function authRoutes(deps: AuthRouteDeps): Router {
  const router = Router();
  const { service } = deps;

  const sendTokens = (res: Response, status: number, pair: TokenPair) => {
    res.cookie(
      REFRESH_COOKIE,
      pair.refreshToken,
      refreshCookieOptions(deps.cookieSecure, deps.refreshTokenTtlSeconds),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(pair);
  };

  // Public JWKS so services (and the gateway) can verify access tokens.
  router.get('/.well-known/jwks.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(deps.signing.jwks);
  });

  router.post('/api/v1/auth/register', async (req, res) => {
    sendTokens(res, 201, await service.register(parseWith(registerSchema, req.body)));
  });

  router.post('/api/v1/auth/login', async (req, res) => {
    sendTokens(res, 200, await service.login(parseWith(loginSchema, req.body)));
  });

  router.post('/api/v1/auth/refresh', async (req, res) => {
    const { refreshToken } = parseWith(refreshSchema, req.body ?? {});
    const token = refreshToken ?? readCookie(req, REFRESH_COOKIE);
    if (!token) throw new UnauthorizedError('Refresh token required');
    sendTokens(res, 200, await service.refresh(token));
  });

  router.post('/api/v1/auth/logout', async (req, res) => {
    const { refreshToken } = parseWith(refreshSchema, req.body ?? {});
    const token = refreshToken ?? readCookie(req, REFRESH_COOKIE);
    if (token) await service.logout(token);
    clearRefreshCookie(res, deps.cookieSecure);
    res.status(204).end();
  });

  router.post('/api/v1/auth/password-reset/request', async (req, res) => {
    const { email } = parseWith(passwordResetRequestSchema, req.body);
    await service.requestPasswordReset(email);
    // Same response whether or not the account exists.
    res.status(202).json({ message: 'If the account exists, a reset link has been sent.' });
  });

  router.post('/api/v1/auth/password-reset/confirm', async (req, res) => {
    const { token, newPassword } = parseWith(passwordResetConfirmSchema, req.body);
    await service.confirmPasswordReset(token, newPassword);
    clearRefreshCookie(res, deps.cookieSecure);
    res.status(204).end();
  });

  router.get('/api/v1/auth/me', authenticate(deps.verifier), (req, res) => {
    const auth = principal(req);
    res.json({ userId: auth.userId, roles: auth.roles, sessionId: auth.sessionId });
  });

  return router;
}
