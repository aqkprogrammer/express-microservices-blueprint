import { ROLES, type Role } from '@emb/contracts';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

export const ACCESS_TOKEN_ISSUER = 'emb-auth-service';
export const ACCESS_TOKEN_AUDIENCE = 'emb-api';
const ALGORITHMS = ['ES256'];

export interface AccessTokenClaims {
  userId: string;
  roles: Role[];
  sessionId: string;
  tokenId: string;
  expiresAt: number;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

export interface VerifierOptions {
  /** Remote JWKS endpoint (auth-service), cached and refreshed on unknown `kid`. */
  jwksUrl?: string;
  /** Static key set, used by auth-service itself and by tests. */
  jwks?: JSONWebKeySet;
  issuer?: string;
  audience?: string;
  clockToleranceSeconds?: number;
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Verifies short-lived ES256 access tokens. Signature, issuer, audience,
 * expiry and token type are all checked; any failure is an InvalidTokenError
 * so callers never branch on library-specific error classes.
 */
export function createAccessTokenVerifier(options: VerifierOptions): AccessTokenVerifier {
  let keySet: JWTVerifyGetKey;
  if (options.jwks) keySet = createLocalJWKSet(options.jwks);
  else if (options.jwksUrl)
    keySet = createRemoteJWKSet(new URL(options.jwksUrl), {
      cooldownDuration: 30_000,
      timeoutDuration: 3_000,
    });
  else throw new Error('Either jwks or jwksUrl is required');

  return {
    async verify(token: string): Promise<AccessTokenClaims> {
      try {
        const { payload } = await jwtVerify(token, keySet, {
          issuer: options.issuer ?? ACCESS_TOKEN_ISSUER,
          audience: options.audience ?? ACCESS_TOKEN_AUDIENCE,
          algorithms: ALGORITHMS,
          clockTolerance: options.clockToleranceSeconds ?? 5,
          requiredClaims: ['sub', 'exp', 'iat', 'jti'],
          typ: 'at+jwt',
        });
        const roles = Array.isArray(payload.roles)
          ? payload.roles.filter((role): role is Role => (ROLES as readonly string[]).includes(String(role)))
          : [];
        if (typeof payload.sid !== 'string' || !payload.sub || !payload.jti || payload.exp === undefined) {
          throw new InvalidTokenError('Token is missing required claims');
        }
        return {
          userId: payload.sub,
          roles,
          sessionId: payload.sid,
          tokenId: payload.jti,
          expiresAt: payload.exp,
        };
      } catch (error) {
        if (error instanceof InvalidTokenError) throw error;
        if (error instanceof errors.JWTExpired) throw new InvalidTokenError('Token has expired');
        if (error instanceof errors.JOSEError) throw new InvalidTokenError('Token is invalid');
        throw error;
      }
    },
  };
}
