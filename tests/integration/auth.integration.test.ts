import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createAccessTokenVerifier } from '@emb/security';
import { startPostgres, type StartedDependency } from '@emb/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../apps/auth-service/src/domain/auth-service.js';
import {
  hashToken,
  loadSigningMaterial,
  type SigningMaterial,
} from '../../apps/auth-service/src/domain/tokens.js';
import { PrismaClient } from '../../apps/auth-service/src/generated/prisma/client.js';
import { createServiceDatabase, prismaFor, silentLogger } from './helpers.js';

let postgres: StartedDependency;
let db: ReturnType<typeof prismaFor<PrismaClient>>;
let auth: AuthService;
let signing: SigningMaterial;
const password = 'correct horse battery staple';
const email = () => `user-${randomUUID().slice(0, 8)}@example.com`;
const outbox = async (type: string) => db.client.outboxEvent.count({ where: { eventType: `${type}.v1` } });

beforeAll(async () => {
  postgres = await startPostgres();
  db = prismaFor(PrismaClient, await createServiceDatabase(postgres, 'auth-service'), 'auth-it');
  signing = await loadSigningMaterial(
    generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  );
  auth = new AuthService({
    prisma: db.client,
    signing,
    logger: silentLogger,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 3_600,
    passwordResetTtlSeconds: 900,
    passwordResetUrl: 'http://localhost/reset',
    maxFailedLogins: 3,
    lockoutSeconds: 60,
    onEventsCommitted: () => undefined,
  });
}, 240_000);

afterAll(async () => {
  await db?.client.$disconnect();
  await db?.close();
  await postgres?.stop();
});

describe('auth service (real Postgres)', () => {
  it('registers with an Argon2id hash, issues verifiable tokens and publishes UserRegistered', async () => {
    const address = email();
    const pair = await auth.register({ email: address.toUpperCase(), password, displayName: 'Ada' });
    const stored = await db.client.credential.findUniqueOrThrow({ where: { email: address } });
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored.passwordHash).not.toContain(password);
    const claims = await createAccessTokenVerifier({ jwks: signing.jwks }).verify(pair.accessToken);
    expect(claims).toMatchObject({ userId: stored.id, roles: ['customer'] });
    // Only the hash of the refresh token is stored.
    expect(await db.client.refreshToken.count({ where: { tokenHash: hashToken(pair.refreshToken) } })).toBe(
      1,
    );
    expect(await db.client.refreshToken.count({ where: { tokenHash: pair.refreshToken } })).toBe(0);
    await expect(auth.register({ email: address, password, displayName: 'Ada' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rotates refresh tokens and revokes the whole session when a rotated token is replayed', async () => {
    const first = await auth.register({ email: email(), password, displayName: 'Bob' });
    const second = await auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const reuseEventsBefore = await outbox('RefreshTokenReuseDetected');
    await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(await outbox('RefreshTokenReuseDetected')).toBe(reuseEventsBefore + 1);
    // The legitimate (latest) token was revoked too: the attacker and the user are both logged out.
    await expect(auth.refresh(second.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('uses one generic error for unknown emails and wrong passwords, and locks out after repeated failures', async () => {
    const address = email();
    await auth.register({ email: address, password, displayName: 'Eve' });
    const unknown = await auth.login({ email: email(), password }).catch((error: unknown) => error);
    const wrong = await auth
      .login({ email: address, password: 'not the password' })
      .catch((error: unknown) => error);
    expect((unknown as Error).message).toBe((wrong as Error).message);
    await auth.login({ email: address, password: 'wrong-2' }).catch(() => undefined);
    await auth.login({ email: address, password: 'wrong-3' }).catch(() => undefined);
    await expect(auth.login({ email: address, password })).rejects.toMatchObject({
      status: 429,
      code: 'account_locked',
    });
  });

  it('logout revokes the session', async () => {
    const pair = await auth.register({ email: email(), password, displayName: 'Lou' });
    await auth.logout(pair.refreshToken);
    await auth.logout(pair.refreshToken); // idempotent
    await expect(auth.refresh(pair.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('resets passwords with a single-use token and revokes existing sessions', async () => {
    const address = email();
    const session = await auth.register({ email: address, password, displayName: 'Rae' });
    await auth.requestPasswordReset(address);
    await auth.requestPasswordReset(`missing-${address}`); // silently ignored (no enumeration)
    const request = await db.client.outboxEvent.findFirstOrThrow({
      where: { eventType: 'NotificationRequested.v1' },
      orderBy: { createdAt: 'desc' },
    });
    const resetUrl = (request.envelope as { payload: { data: { resetUrl: string } } }).payload.data.resetUrl;
    const token = new URL(resetUrl).searchParams.get('token')!;
    // The token is only stored hashed.
    expect(await db.client.passwordResetToken.count({ where: { tokenHash: token } })).toBe(0);

    await auth.confirmPasswordReset(token, 'a brand new passphrase');
    await expect(auth.confirmPasswordReset(token, 'another new passphrase')).rejects.toMatchObject({
      code: 'invalid_reset_token',
    });
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login({ email: address, password: 'a brand new passphrase' })).resolves.toHaveProperty(
      'accessToken',
    );
  });

  it('blocks logins and revokes sessions when the account is suspended', async () => {
    const pair = await auth.register({ email: email(), password, displayName: 'Sam' });
    await auth.applyStatusChange(randomUUID(), {
      userId: pair.user.id,
      status: 'suspended',
      previousStatus: 'active',
      reason: 'test',
      changedBy: randomUUID(),
    });
    await expect(auth.refresh(pair.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login({ email: pair.user.email, password })).rejects.toMatchObject({ status: 401 });
  });
});
