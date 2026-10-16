import { generateKeyPairSync } from 'node:crypto';
import { createAccessTokenVerifier } from '@emb/security';
import { describe, expect, it } from 'vitest';
import { generateOpaqueToken, hashToken, loadSigningMaterial, signAccessToken } from './tokens.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';

const pem = () =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

describe('token issuing', () => {
  it('issues ES256 access tokens that the shared verifier accepts', async () => {
    const material = await loadSigningMaterial(pem());
    const token = await signAccessToken(
      material,
      {
        userId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
        roles: ['admin'],
        sessionId: 'b3d1c5e2-0000-4000-8000-000000000000',
      },
      60,
    );
    const claims = await createAccessTokenVerifier({ jwks: material.jwks }).verify(token);
    expect(claims).toMatchObject({ userId: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed', roles: ['admin'] });
  });

  it('publishes both current and previous keys during rotation', async () => {
    const previous = await loadSigningMaterial(pem());
    const { createPublicKey } = await import('node:crypto');
    const previousPem = pem();
    const material = await loadSigningMaterial(
      pem(),
      createPublicKey(previousPem).export({ type: 'spki', format: 'pem' }).toString(),
    );
    expect(material.jwks.keys).toHaveLength(2);
    expect(material.jwks.keys.every((key) => key.d === undefined)).toBe(true);
    expect(previous.kid).not.toBe(material.kid);
  });

  it('generates high-entropy opaque tokens and stores only hashes', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('password hashing', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password!!')).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('treats malformed hashes as a failed verification', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false);
  });
});
