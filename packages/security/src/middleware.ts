import type { Role } from '@emb/contracts';
import { ForbiddenError, ServiceUnavailableError, UnauthorizedError } from '@emb/http-kit';
import { updateRequestContext } from '@emb/logger';
import type { Request, RequestHandler } from 'express';
import { constantTimeEqual } from './crypto.js';
import { InvalidTokenError, type AccessTokenVerifier } from './tokens.js';

export interface Principal {
  userId: string;
  roles: Role[];
  sessionId: string;
  tokenId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: Principal;
  }
}

/**
 * Verifies the bearer token and attaches the principal to `req.auth`. With
 * `optional`, anonymous requests pass through, but a present-and-invalid
 * token is still rejected (never silently downgraded to anonymous).
 */
export function authenticate(
  verifier: AccessTokenVerifier,
  options: { optional?: boolean } = {},
): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization');
    if (!header && options.optional) {
      next();
      return;
    }
    const match = header ? /^Bearer ([A-Za-z0-9._-]+)$/.exec(header) : null;
    if (!match?.[1]) {
      next(new UnauthorizedError());
      return;
    }
    try {
      const claims = await verifier.verify(match[1]);
      req.auth = {
        userId: claims.userId,
        roles: claims.roles,
        sessionId: claims.sessionId,
        tokenId: claims.tokenId,
      };
      updateRequestContext({ userId: claims.userId });
      next();
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        next(new UnauthorizedError(error.message));
        return;
      }
      // JWKS endpoint unreachable: fail closed, but report it as a dependency problem.
      next(new ServiceUnavailableError('Token verification is temporarily unavailable', error));
    }
  };
}

export const isAdmin = (req: Request) => req.auth?.roles.includes('admin') === true;

/** Returns the authenticated principal or throws 401. */
export function principal(req: Request): Principal {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}

export function requireRoles(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const auth = req.auth;
    if (!auth) {
      next(new UnauthorizedError());
      return;
    }
    if (!roles.some((role) => auth.roles.includes(role))) {
      next(new ForbiddenError());
      return;
    }
    next();
  };
}

/** Resource-level authorization: owners may access their own data, admins anything. */
export function assertOwnerOrAdmin(auth: Principal, ownerId: string): void {
  if (auth.userId !== ownerId && !auth.roles.includes('admin')) throw new ForbiddenError();
}

/**
 * Guards `/internal/*` endpoints used for service-to-service calls. The gateway
 * never routes these paths; the token is defence in depth for the private network.
 */
export function requireInternalToken(expected: string): RequestHandler {
  return (req, _res, next) => {
    const provided = req.header('x-internal-token');
    if (!provided || !constantTimeEqual(provided, expected)) {
      next(new UnauthorizedError('Internal token required'));
      return;
    }
    next();
  };
}
