# Authentication

`apps/auth-service` is a **reference implementation** ([ADR-0015](../decisions/0015-reference-authentication-vs-identity-provider.md)). It shows how to do token-based authentication carefully; for production, an established identity provider is recommended (see [When to use an external identity provider](#when-to-use-an-external-identity-provider)).

## Endpoints

All routed through the gateway at `http://localhost:8080`. Credential endpoints are limited to 20 requests per minute per IP.

| Method and path                            | Purpose                                            | Response                                    |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------- |
| `POST /api/v1/auth/register`               | Create a `customer` account and open a session     | `201` token pair + refresh cookie           |
| `POST /api/v1/auth/login`                  | Open a session                                     | `200` token pair + refresh cookie           |
| `POST /api/v1/auth/refresh`                | Rotate the refresh token, get a new access token   | `200` token pair + refresh cookie           |
| `POST /api/v1/auth/logout`                 | Revoke the session (refresh-token family)          | `204`, cookie cleared (idempotent)          |
| `POST /api/v1/auth/password-reset/request` | Email a reset link                                 | Always `202`                                |
| `POST /api/v1/auth/password-reset/confirm` | Set a new password with the token                  | `204`, all sessions revoked                 |
| `GET /api/v1/auth/me`                      | Current principal (`userId`, `roles`, `sessionId`) | `200`                                       |
| `GET /.well-known/jwks.json`               | Public signing keys                                | `200`, `Cache-Control: public, max-age=300` |

Token responses carry `Cache-Control: no-store`. Request examples are in the [API guide](../api/README.md#authentication).

## Token design

### Access token

| Property          | Value                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Format            | JWT, signed with **ES256** (P-256); header `typ: at+jwt`, `kid` = JWK thumbprint                               |
| Lifetime          | 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`, 60–3600)                                                               |
| Issuer / audience | `emb-auth-service` / `emb-api`                                                                                 |
| Claims            | `sub` (user ID), `roles` (`customer`, `admin`), `sid` (session = refresh-token family ID), `jti`, `iat`, `exp` |
| Transport         | `Authorization: Bearer <token>`                                                                                |

Every service verifies tokens locally (`packages/security/src/tokens.ts`): signature against the JWKS from `JWKS_URL` (fetched on demand, refetched on unknown `kid` with a 30 s cooldown, 3 s timeout), algorithm restricted to ES256, issuer, audience, `typ`, required claims, and expiry with 5 s clock tolerance. Unknown roles are dropped. If the JWKS cannot be fetched, requests fail with `503 service_unavailable` rather than being let through.

### Refresh token

| Property          | Value                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format            | Opaque, 256 bits of randomness (base64url)                                                                                                                                        |
| Storage           | Only the SHA-256 hash is stored (`refresh_tokens.token_hash`)                                                                                                                     |
| Lifetime          | 7 days (`REFRESH_TOKEN_TTL_SECONDS`, 1 h–30 days), renewed with every rotation (sliding session; no absolute session limit)                                                       |
| Browser transport | Cookie `emb_refresh_token`: `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Secure` when `COOKIE_SECURE=true`                                                                |
| Other clients     | Also returned in the JSON body and accepted in the body of `/refresh` and `/logout`. Browser apps should rely on the cookie and not store the body copy (e.g. in `localStorage`). |

### Rotation and reuse detection

Every `POST /api/v1/auth/refresh`, in one transaction with the token row locked:

1. Unknown, expired token, or inactive account → `401 unauthorized`.
2. Token already revoked (it was rotated before) → this is a **replay of a stolen or copied token**: every still-active token in the family is revoked (`reuse_detected`), `RefreshTokenReuseDetected` is published (audited) and the call returns `401`. Both the attacker and the legitimate user must log in again.
3. Otherwise a new refresh token is issued in the same family, the presented one is marked `rotated` and linked to its successor, and a new access token is returned.

Logout revokes the whole family (`UserLoggedOut`). Expired token rows are deleted one day after expiry ([data retention](../operations/data-retention.md)).

## Passwords and login

- **Hashing:** Argon2id, memory 19 MiB, 2 iterations, parallelism 1 (OWASP minimum). Parameters are stored in the hash, and login transparently rehashes when they change. Tune upward for production hardware; each concurrent login needs ~19 MiB, which is why auth-service has a larger memory limit in Compose.
- **Policy:** 12–128 characters, no composition rules. A breached-password check is **not** implemented (recommended for production).
- **Enumeration resistance:** unknown emails and wrong passwords return the same `401 "Invalid email or password"`; for unknown emails a dummy Argon2id verification equalises timing. Inactive accounts also get the generic message. Registration with an existing email returns `409 email_taken` — registration inherently reveals whether an email exists; add CAPTCHA/email verification if that matters.
- **Lockout:** after 5 consecutive failures (`MAX_FAILED_LOGINS`, 3–20) the account is locked for 15 minutes (`LOCKOUT_SECONDS`); attempts during the lock return `429 account_locked` with `Retry-After`, even with the correct password. A successful login resets the counter. Trade-off: anyone who knows an email can lock that account temporarily; gateway rate limiting reduces but does not remove this.
- **Audit:** `LoginFailed` (never containing the submitted email or password), `UserLoggedIn`, `UserLoggedOut`, `PasswordResetRequested`, `PasswordChanged`, `RefreshTokenReuseDetected` are recorded by audit-service.

## Password reset

1. `POST /password-reset/request` always answers `202` with the same message. Only active accounts get a token.
2. A 256-bit token is generated; only its hash is stored, with a 15-minute expiry (`PASSWORD_RESET_TTL_SECONDS`, 5–60 min). Requesting again invalidates earlier unused tokens.
3. The link `PASSWORD_RESET_URL?token=…` travels to notification-service inside `NotificationRequested`, with `sensitiveDataKeys: ["resetUrl"]`; the notification row's copy is scrubbed after sending or final failure. The web page that would host the form is out of scope; locally the email appears in Mailpit (<http://localhost:8025>).
4. `POST /password-reset/confirm` with `{token, newPassword}` succeeds once: it sets the new password, clears the lockout, revokes **all** refresh tokens of the user, publishes `PasswordChanged`, and clears the cookie. Invalid, used or expired tokens return `400 invalid_reset_token`.

Note that the reset link also exists, until retention removes it, in auth-service's published outbox row (kept 24 h instead of 72 h for this reason) and, if delivery dead-letters, in the worker's dead-letter archive.

## Account status

user-service owns account status (`active`, `suspended`, `closed`; closed is final; admins cannot change their own status) and publishes `UserStatusChanged`. auth-service consumes it, blocks login for inactive accounts and revokes all their refresh tokens. Refresh is also refused for inactive accounts.

## Logout and revocation limits

There is **no access-token denylist**. After logout, password reset, suspension or closure, refresh tokens are revoked immediately, but an already-issued access token remains valid until it expires — **at most 15 minutes** by default. If that window is unacceptable: shorten `ACCESS_TOKEN_TTL_SECONDS`, or add a denylist of `jti`/`sid` values checked by services (not implemented).

## Signing keys and rotation

- auth-service loads an ES256 private key (PKCS#8 PEM) from `JWT_PRIVATE_KEY` or `JWT_PRIVATE_KEY_FILE`. In Compose the one-shot `keygen` container creates it once in the `jwt-keys` volume (readable only by uid 1000). For running from source, `npm run keys:generate` writes `secrets/jwt-private.pem` (git-ignored).
- The JWKS publishes the current public key and, if set, `JWT_PREVIOUS_PUBLIC_KEY` (SPKI PEM; `JWT_PREVIOUS_PUBLIC_KEY_FILE` also works).

Rotation procedure:

1. Generate a new private key (e.g. `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out new.pem`) in your secret store.
2. Export the current public key: `openssl pkey -in current.pem -pubout -out previous-public.pem`.
3. Deploy auth-service with the new private key and `JWT_PREVIOUS_PUBLIC_KEY_FILE=previous-public.pem`. New tokens use the new `kid`; services fetch the JWKS again when they meet an unknown `kid`; tokens signed with the old key keep verifying.
4. After at least the access-token lifetime (15 min) plus clock skew, remove `JWT_PREVIOUS_PUBLIC_KEY`. Refresh tokens are opaque and unaffected by key rotation.

If the private key is compromised, skip step 2 (do not keep the old key in the JWKS): all outstanding access tokens become invalid immediately and users must refresh (refresh tokens still work) or log in.

Locally, deleting the `jwt-keys` volume creates a new key on next start; previously issued access tokens then fail with `401` ([troubleshooting](../troubleshooting/README.md#401-invalid-token-after-restart)).

## Bootstrap administrator

On start, if `ADMIN_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` are set and no account with that email exists, auth-service creates it with role `admin`. Locally: `admin@example.test` / `local-dev-admin-password`. In production, provision administrators through your identity process and do not leave a bootstrap password in the environment. There is no endpoint to grant the admin role.

## When to use an external identity provider

Use an established provider — e.g. **Keycloak** (self-hosted), **Auth0/Okta**, **Amazon Cognito**, **Microsoft Entra ID**, **Google Identity Platform** — when you need any of: MFA or passkeys, social or enterprise login (OIDC/SAML), email verification, self-service account management, compliance attestations, or simply do not want to own credential storage.

Migration outline (not implemented):

1. Point every service's `JWKS_URL` at the provider and pass the provider's issuer and audience where each service creates its verifier (`createAccessTokenVerifier` accepts `issuer`/`audience` options; the defaults are this auth-service's values, and no environment variable exists for them yet).
2. Map the provider's role or group claim to `roles` (`customer`/`admin`) and ensure `sub`, `jti` and a session claim (`sid`) are present, or adapt `packages/security/src/tokens.ts`.
3. Replace `UserRegistered` (which creates profiles and notification recipients) with a provisioning hook or a first-login handler that publishes an equivalent event.
4. Retire auth-service's credential tables, lockout and reset flows.
