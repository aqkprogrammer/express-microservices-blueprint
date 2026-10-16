import { randomUUID } from 'node:crypto';
import type { EventPayload, Role } from '@emb/contracts';
import { enqueueEvent, isUniqueViolation, markMessageProcessed } from '@emb/database';
import { AppError, ConflictError, UnauthorizedError } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import { counter } from '@emb/observability';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from './passwords.js';
import { generateOpaqueToken, hashToken, signAccessToken, type SigningMaterial } from './tokens.js';

const PRODUCER = 'auth-service';
const authOutcomes = counter('auth_operations_total', 'Authentication operations by outcome', [
  'operation',
  'outcome',
]);

type Tx = Prisma.TransactionClient;
const meta = (userId: string) => ({ producer: PRODUCER, aggregateType: 'user', aggregateId: userId });

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string; roles: Role[] };
}

export interface AuthServiceDeps {
  prisma: PrismaClient;
  signing: SigningMaterial;
  logger: Logger;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  passwordResetTtlSeconds: number;
  passwordResetUrl: string;
  maxFailedLogins: number;
  lockoutSeconds: number;
  onEventsCommitted: () => void;
}

/** Generic message so responses never reveal whether an email is registered. */
const INVALID_CREDENTIALS = 'Invalid email or password';

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async register(
    input: { email: string; password: string; displayName: string },
    roles: Role[] = ['customer'],
  ): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();
    try {
      const result = await this.deps.prisma.$transaction(async (tx) => {
        await tx.credential.create({ data: { id: userId, email, passwordHash, roles } });
        await enqueueEvent(
          tx,
          'UserRegistered',
          { userId, email, displayName: input.displayName, roles, registeredAt: new Date().toISOString() },
          meta(userId),
        );
        return this.openSession(tx, { id: userId, email, roles });
      });
      this.deps.onEventsCommitted();
      authOutcomes.inc({ operation: 'register', outcome: 'success' });
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        authOutcomes.inc({ operation: 'register', outcome: 'duplicate' });
        throw new ConflictError('An account with this email already exists', 'email_taken');
      }
      throw error;
    }
  }

  async login(input: { email: string; password: string }): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    const credential = await this.deps.prisma.credential.findUnique({ where: { email } });
    if (!credential) {
      await burnPasswordCheck(input.password);
      await this.recordLoginFailure(null, 'invalid_credentials');
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }
    if (credential.lockedUntil && credential.lockedUntil > new Date()) {
      await burnPasswordCheck(input.password);
      authOutcomes.inc({ operation: 'login', outcome: 'locked' });
      throw new AppError(429, 'account_locked', 'Too many failed attempts. Try again later.', {
        headers: { 'Retry-After': String(Math.ceil((credential.lockedUntil.getTime() - Date.now()) / 1000)) },
      });
    }
    const valid = await verifyPassword(credential.passwordHash, input.password);
    if (!valid) {
      const failures = credential.failedLoginCount + 1;
      const lock = failures >= this.deps.maxFailedLogins;
      await this.deps.prisma.credential.update({
        where: { id: credential.id },
        data: {
          failedLoginCount: lock ? 0 : failures,
          lockedUntil: lock ? new Date(Date.now() + this.deps.lockoutSeconds * 1000) : null,
        },
      });
      await this.recordLoginFailure(credential.id, 'invalid_credentials');
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }
    if (credential.status !== 'active') {
      await this.recordLoginFailure(credential.id, 'account_inactive');
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }
    const rehash = needsRehash(credential.passwordHash) ? await hashPassword(input.password) : undefined;
    const result = await this.deps.prisma.$transaction(async (tx) => {
      await tx.credential.update({
        where: { id: credential.id },
        data: { failedLoginCount: 0, lockedUntil: null, ...(rehash ? { passwordHash: rehash } : {}) },
      });
      const pair = await this.openSession(tx, {
        id: credential.id,
        email: credential.email,
        roles: credential.roles as Role[],
      });
      return pair;
    });
    this.deps.onEventsCommitted();
    authOutcomes.inc({ operation: 'login', outcome: 'success' });
    return result;
  }

  /**
   * Refresh-token rotation with reuse detection. Each refresh revokes the
   * presented token and issues a new one in the same family. Presenting an
   * already-rotated token means it was copied — the whole family (session) is
   * revoked and the event is audited.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(refreshToken);
    const outcome = await this.deps.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id::text FROM refresh_tokens WHERE token_hash = ${tokenHash} FOR UPDATE`;
      if (!rows[0]) return { kind: 'invalid' as const };
      const current = await tx.refreshToken.findUniqueOrThrow({
        where: { id: rows[0].id },
        include: { user: true },
      });
      if (current.revokedAt) {
        await tx.refreshToken.updateMany({
          where: { familyId: current.familyId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'reuse_detected' },
        });
        await enqueueEvent(
          tx,
          'RefreshTokenReuseDetected',
          { userId: current.userId, sessionId: current.familyId },
          meta(current.userId),
        );
        return { kind: 'reuse' as const };
      }
      if (current.expiresAt <= new Date() || current.user.status !== 'active')
        return { kind: 'invalid' as const };
      const pair = await this.issueTokens(
        tx,
        { id: current.user.id, email: current.user.email, roles: current.user.roles as Role[] },
        current.familyId,
      );
      const next = await tx.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hashToken(pair.refreshToken) },
      });
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { revokedAt: new Date(), revokedReason: 'rotated', replacedById: next.id },
      });
      return { kind: 'ok' as const, pair };
    });
    if (outcome.kind === 'reuse') {
      this.deps.onEventsCommitted();
      authOutcomes.inc({ operation: 'refresh', outcome: 'reuse_detected' });
      this.deps.logger.warn('refresh token reuse detected; session revoked');
      throw new UnauthorizedError('Refresh token is no longer valid');
    }
    if (outcome.kind === 'invalid') {
      authOutcomes.inc({ operation: 'refresh', outcome: 'invalid' });
      throw new UnauthorizedError('Refresh token is no longer valid');
    }
    authOutcomes.inc({ operation: 'refresh', outcome: 'success' });
    return outcome.pair;
  }

  /** Revokes the session (token family) the refresh token belongs to. Idempotent. */
  async logout(refreshToken: string): Promise<void> {
    const token = await this.deps.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!token) return;
    await this.deps.prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: { familyId: token.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });
      if (revoked.count > 0) {
        await enqueueEvent(
          tx,
          'UserLoggedOut',
          { userId: token.userId, sessionId: token.familyId },
          meta(token.userId),
        );
      }
    });
    this.deps.onEventsCommitted();
  }

  /**
   * Always succeeds from the caller's point of view (no account enumeration).
   * The raw token only travels inside the NotificationRequested event, marked
   * sensitive so the notification service scrubs it after delivery.
   */
  async requestPasswordReset(emailInput: string): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const credential = await this.deps.prisma.credential.findUnique({ where: { email } });
    if (!credential || credential.status !== 'active') {
      authOutcomes.inc({ operation: 'password_reset_request', outcome: 'ignored' });
      return;
    }
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.deps.passwordResetTtlSeconds * 1000);
    await this.deps.prisma.$transaction(async (tx) => {
      // Only the newest reset link is valid.
      await tx.passwordResetToken.updateMany({
        where: { userId: credential.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: { id: randomUUID(), userId: credential.id, tokenHash: hashToken(token), expiresAt },
      });
      await enqueueEvent(
        tx,
        'PasswordResetRequested',
        { userId: credential.id, expiresAt: expiresAt.toISOString() },
        meta(credential.id),
      );
      await enqueueEvent(
        tx,
        'NotificationRequested',
        {
          recipientUserId: credential.id,
          template: 'password-reset',
          data: {
            resetUrl: `${this.deps.passwordResetUrl}?token=${token}`,
            expiresInMinutes: Math.round(this.deps.passwordResetTtlSeconds / 60),
          },
          sensitiveDataKeys: ['resetUrl'],
        },
        meta(credential.id),
      );
    });
    this.deps.onEventsCommitted();
    authOutcomes.inc({ operation: 'password_reset_request', outcome: 'issued' });
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    const ok = await this.deps.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; user_id: string }[]>`
        SELECT id::text, user_id::text FROM password_reset_tokens
         WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
         FOR UPDATE`;
      const reset = rows[0];
      if (!reset) return false;
      await tx.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
      await tx.credential.update({
        where: { id: reset.user_id },
        data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      });
      // A password reset ends every existing session.
      await tx.refreshToken.updateMany({
        where: { userId: reset.user_id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'password_reset' },
      });
      await enqueueEvent(
        tx,
        'PasswordChanged',
        { userId: reset.user_id, method: 'reset' },
        meta(reset.user_id),
      );
      return true;
    });
    if (!ok) {
      authOutcomes.inc({ operation: 'password_reset_confirm', outcome: 'invalid' });
      throw new AppError(400, 'invalid_reset_token', 'The reset link is invalid or has expired');
    }
    this.deps.onEventsCommitted();
    authOutcomes.inc({ operation: 'password_reset_confirm', outcome: 'success' });
  }

  /** Mirrors account status from user-service; deactivation revokes all sessions. */
  async applyStatusChange(messageId: string, payload: EventPayload<'UserStatusChanged'>): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      if (!(await markMessageProcessed(tx, 'auth.user-status-changed', messageId))) return;
      const updated = await tx.credential.updateMany({
        where: { id: payload.userId },
        data: { status: payload.status },
      });
      if (updated.count === 0) return;
      if (payload.status !== 'active') {
        await tx.refreshToken.updateMany({
          where: { userId: payload.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: `account_${payload.status}` },
        });
      }
    });
    this.deps.logger.info({ userId: payload.userId, status: payload.status }, 'credential status updated');
  }

  /** Creates the bootstrap admin when configured and absent (idempotent). */
  async ensureAdmin(email: string, password: string): Promise<boolean> {
    const existing = await this.deps.prisma.credential.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return false;
    await this.register({ email, password, displayName: 'Administrator' }, ['admin']);
    return true;
  }

  async deleteExpiredTokens(): Promise<number> {
    const cutoff = new Date(Date.now() - 86_400_000);
    const refresh = await this.deps.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    const reset = await this.deps.prisma.passwordResetToken.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return refresh.count + reset.count;
  }

  private async openSession(tx: Tx, user: { id: string; email: string; roles: Role[] }): Promise<TokenPair> {
    const sessionId = randomUUID();
    const pair = await this.issueTokens(tx, user, sessionId);
    await enqueueEvent(tx, 'UserLoggedIn', { userId: user.id, sessionId }, meta(user.id));
    return pair;
  }

  private async issueTokens(
    tx: Tx,
    user: { id: string; email: string; roles: Role[] },
    familyId: string,
  ): Promise<TokenPair> {
    const refreshToken = generateOpaqueToken();
    const refreshExpiresAt = new Date(Date.now() + this.deps.refreshTokenTtlSeconds * 1000);
    await tx.refreshToken.create({
      data: {
        id: randomUUID(),
        familyId,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });
    const accessToken = await signAccessToken(
      this.deps.signing,
      { userId: user.id, roles: user.roles, sessionId: familyId },
      this.deps.accessTokenTtlSeconds,
    );
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.deps.accessTokenTtlSeconds,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, roles: user.roles },
    };
  }

  private async recordLoginFailure(
    userId: string | null,
    reason: 'invalid_credentials' | 'account_inactive',
  ): Promise<void> {
    authOutcomes.inc({ operation: 'login', outcome: reason });
    await this.deps.prisma.$transaction(async (tx) => {
      await enqueueEvent(tx, 'LoginFailed', { userId, reason }, meta(userId ?? 'unknown'));
    });
    this.deps.onEventsCommitted();
  }
}
