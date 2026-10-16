import { createServiceApp } from '@emb/http-kit';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { pino } from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authenticate, requireInternalToken, requireRoles } from './middleware.js';
import { createAccessTokenVerifier, type AccessTokenVerifier } from './tokens.js';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let verifier: AccessTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  verifier = createAccessTokenVerifier({ jwks: { keys: [jwk] } });
});

const sign = (claims: Record<string, unknown>, options: { exp?: string; aud?: string; typ?: string } = {}) =>
  new SignJWT({ roles: ['customer'], sid: '3f1d1c9e-1111-4111-8111-111111111111', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: options.typ ?? 'at+jwt' })
    .setIssuer('emb-auth-service')
    .setAudience(options.aud ?? 'emb-api')
    .setSubject('8c0a7f5e-2222-4222-8222-222222222222')
    .setJti('jti-1')
    .setIssuedAt()
    .setExpirationTime(options.exp ?? '5m')
    .sign(privateKey);

const app = () =>
  createServiceApp({
    serviceName: 'test',
    logger: pino({ level: 'silent' }),
    routes: (express) => {
      express.get('/me', authenticate(verifier), (req, res) => {
        res.json(req.auth);
      });
      express.get('/admin', authenticate(verifier), requireRoles('admin'), (_req, res) => {
        res.json({ ok: true });
      });
      express.get('/internal', requireInternalToken('s3cret-internal-token'), (_req, res) => {
        res.json({ ok: true });
      });
    },
  });

describe('authentication middleware', () => {
  it('accepts a valid access token', async () => {
    const response = await request(app())
      .get('/me')
      .set('Authorization', `Bearer ${await sign({})}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      userId: '8c0a7f5e-2222-4222-8222-222222222222',
      roles: ['customer'],
    });
  });

  it('rejects missing, expired, wrong-audience and wrong-type tokens', async () => {
    expect((await request(app()).get('/me')).status).toBe(401);
    const cases = [
      await sign({}, { exp: '-1m' }),
      await sign({}, { aud: 'other-api' }),
      await sign({}, { typ: 'JWT' }),
      'not.a.jwt',
    ];
    for (const token of cases) {
      const response = await request(app()).get('/me').set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('enforces roles', async () => {
    const customer = await request(app())
      .get('/admin')
      .set('Authorization', `Bearer ${await sign({})}`);
    expect(customer.status).toBe(403);
    const admin = await request(app())
      .get('/admin')
      .set('Authorization', `Bearer ${await sign({ roles: ['admin'] })}`);
    expect(admin.status).toBe(200);
  });

  it('drops unknown roles from tokens', async () => {
    const response = await request(app())
      .get('/me')
      .set('Authorization', `Bearer ${await sign({ roles: ['customer', 'superuser'] })}`);
    expect(response.body.roles).toEqual(['customer']);
  });

  it('guards internal endpoints with a shared token', async () => {
    expect((await request(app()).get('/internal')).status).toBe(401);
    expect((await request(app()).get('/internal').set('x-internal-token', 'wrong')).status).toBe(401);
    expect(
      (await request(app()).get('/internal').set('x-internal-token', 's3cret-internal-token')).status,
    ).toBe(200);
  });
});
