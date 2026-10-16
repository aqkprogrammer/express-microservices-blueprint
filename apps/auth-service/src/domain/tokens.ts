import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from '@emb/security';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  importPKCS8,
  importSPKI,
  type JSONWebKeySet,
  type JWK,
} from 'jose';
import { createPublicKey } from 'node:crypto';

export interface SigningMaterial {
  privateKey: Awaited<ReturnType<typeof importPKCS8>>;
  kid: string;
  jwks: JSONWebKeySet;
}

/** Loads the ES256 signing key and builds the public JWKS (current + optional previous key). */
export async function loadSigningMaterial(
  privateKeyPem: string,
  previousPublicKeyPem?: string,
): Promise<SigningMaterial> {
  const privateKey = await importPKCS8(privateKeyPem, 'ES256', { extractable: false });
  const publicPem = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  const toJwk = async (pem: string): Promise<JWK> => {
    const jwk = await exportJWK(await importSPKI(pem, 'ES256', { extractable: true }));
    return { ...jwk, kid: await calculateJwkThumbprint(jwk), alg: 'ES256', use: 'sig' };
  };
  const current = await toJwk(publicPem);
  const keys = [current];
  if (previousPublicKeyPem) keys.push(await toJwk(previousPublicKeyPem));
  return { privateKey, kid: current.kid ?? '', jwks: { keys } };
}

export async function signAccessToken(
  material: SigningMaterial,
  claims: { userId: string; roles: string[]; sessionId: string },
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ roles: claims.roles, sid: claims.sessionId })
    .setProtectedHeader({ alg: 'ES256', kid: material.kid, typ: 'at+jwt' })
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(claims.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(material.privateKey);
}

/** 256-bit opaque token for refresh and password-reset flows. */
export const generateOpaqueToken = () => randomBytes(32).toString('base64url');

/** Only hashes are stored, so a database leak does not expose usable tokens. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
