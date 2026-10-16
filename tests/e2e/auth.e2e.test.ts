import { describe, expect, it } from 'vitest';
import { api, emailText, loginAdmin, poll, registerCustomer, waitForEmail } from '../support/api.js';

describe('authentication and authorization (end to end)', () => {
  it('registers, provisions the profile asynchronously, and exposes only safe fields', async () => {
    const session = await registerCustomer('auth');
    const me = await api('GET', '/api/v1/auth/me', { token: session.token });
    expect(me.body).toMatchObject({ userId: session.userId, roles: ['customer'] });
    const profile = await poll(async () => {
      const response = await api('GET', '/api/v1/users/me', { token: session.token });
      return response.status === 200 ? response.body : undefined;
    }, 'profile created from UserRegistered');
    expect(profile).toMatchObject({ id: session.userId, email: session.email, status: 'active' });
    expect(JSON.stringify(profile)).not.toMatch(/password|hash/i);
    await waitForEmail(session.email, /Welcome/);
  });

  it('rotates refresh tokens and revokes the session on replay', async () => {
    const session = await registerCustomer('rotation');
    const rotated = await api('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    });
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get('cache-control')).toBe('no-store');
    expect(rotated.headers.get('set-cookie')).toMatch(/emb_refresh_token=.*HttpOnly.*SameSite=Strict/i);
    const replay = await api('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    });
    expect(replay.status).toBe(401);
    const revoked = await api('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: rotated.body.refreshToken },
    });
    expect(revoked.status).toBe(401);
  });

  it('logs out by revoking the refresh token family', async () => {
    const session = await registerCustomer('logout');
    expect(
      (await api('POST', '/api/v1/auth/logout', { body: { refreshToken: session.refreshToken } })).status,
    ).toBe(204);
    expect(
      (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } })).status,
    ).toBe(401);
  });

  it('resets a password through the emailed single-use link', async () => {
    const session = await registerCustomer('reset');
    const unknown = await api('POST', '/api/v1/auth/password-reset/request', {
      body: { email: `nobody-${session.email}` },
    });
    const known = await api('POST', '/api/v1/auth/password-reset/request', {
      body: { email: session.email },
    });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body); // no account enumeration

    const email = await waitForEmail(session.email, /Reset your password/);
    const token = /token=([A-Za-z0-9_-]+)/.exec(await emailText(email.ID))?.[1];
    expect(token).toBeDefined();
    const confirm = await api('POST', '/api/v1/auth/password-reset/confirm', {
      body: { token, newPassword: 'an entirely new passphrase' },
    });
    expect(confirm.status).toBe(204);
    expect(
      (
        await api('POST', '/api/v1/auth/password-reset/confirm', {
          body: { token, newPassword: 'and yet another one' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } })).status,
    ).toBe(401);
    const login = await api('POST', '/api/v1/auth/login', {
      body: { email: session.email, password: 'an entirely new passphrase' },
    });
    expect(login.status).toBe(200);
  });

  it('enforces authentication, roles and resource ownership', async () => {
    const [alice, bob] = await Promise.all([registerCustomer('alice'), registerCustomer('bob')]);
    expect((await api('GET', '/api/v1/orders')).status).toBe(401);
    expect((await api('GET', '/api/v1/orders', { token: 'not-a-jwt' })).status).toBe(401);
    for (const path of [
      '/api/v1/users',
      '/api/v1/inventory',
      '/api/v1/audit-events',
      '/api/v1/notifications/templates',
    ]) {
      expect((await api('GET', path, { token: alice.token })).status, path).toBe(403);
    }
    const order = await api('POST', '/api/v1/orders', {
      token: alice.token,
      body: { lines: [{ productId: '0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2007', quantity: 1 }] },
      headers: { 'Idempotency-Key': `own-${alice.userId}` },
    });
    // Other customers' resources are indistinguishable from missing ones.
    expect((await api('GET', `/api/v1/orders/${order.body.id}`, { token: bob.token })).status).toBe(404);
    expect((await api('GET', `/api/v1/users/${alice.userId}`, { token: bob.token })).status).toBe(403);
  });

  it('suspending an account blocks login and revokes sessions', async () => {
    const [session, admin] = await Promise.all([registerCustomer('suspend'), loginAdmin()]);
    await poll(
      async () =>
        (await api('GET', `/api/v1/users/${session.userId}`, { token: admin })).status === 200 || undefined,
      'profile',
    );
    const suspended = await api('PATCH', `/api/v1/users/${session.userId}/status`, {
      token: admin,
      body: { status: 'suspended', reason: 'e2e test' },
    });
    expect(suspended.body).toMatchObject({ status: 'suspended' });
    await poll(
      async () =>
        (await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } }))
          .status === 401 || undefined,
      'session revocation via UserStatusChanged',
    );
    const login = await api('POST', '/api/v1/auth/login', {
      body: { email: session.email, password: 'correct horse battery staple' },
    });
    expect(login.status).toBe(401);
  });

  it('records security events in the audit trail without personal data', async () => {
    const admin = await loginAdmin();
    const records = await poll(async () => {
      const response = await api('GET', '/api/v1/audit-events?category=security&pageSize=50', {
        token: admin,
      });
      return response.body?.data?.length > 0 ? response.body.data : undefined;
    }, 'audit records');
    expect(records.map((record: { eventType: string }) => record.eventType)).toEqual(
      expect.arrayContaining(['UserLoggedIn.v1']),
    );
    expect(JSON.stringify(records)).not.toMatch(/@example\.(com|test)/);
  });
});
