import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';

export interface TestKeys {
  jwks: JSONWebKeySet;
  sign(claims: { userId: string; roles?: string[]; sessionId?: string; expiresIn?: string }): Promise<string>;
}

/** Ephemeral ES256 key pair for tests; mirrors the claims auth-service issues. */
export async function createTestKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  return {
    jwks: { keys: [jwk] },
    sign: ({
      userId,
      roles = ['customer'],
      sessionId = '00000000-0000-4000-8000-000000000001',
      expiresIn = '5m',
    }) =>
      new SignJWT({ roles, sid: sessionId })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key', typ: 'at+jwt' })
        .setIssuer('emb-auth-service')
        .setAudience('emb-api')
        .setSubject(userId)
        .setJti(crypto.randomUUID())
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(privateKey),
  };
}
