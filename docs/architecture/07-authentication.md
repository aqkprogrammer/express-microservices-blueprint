# 7. Authentication flow

[← Retry and dead-letter flow](06-retry-dead-letter.md) · [Index](README.md) · Next: [Observability →](08-observability.md)

auth-service ([`apps/auth-service`](../../apps/auth-service)) issues short-lived **ES256 access
tokens** (15 min, `typ: at+jwt`, `iss: emb-auth-service`, `aud: emb-api`, claims `sub`, `roles`,
`sid`, `jti`) and opaque **256-bit refresh tokens** stored only as SHA-256 hashes. The refresh
token travels in an `HttpOnly`, `SameSite=Strict` cookie `emb_refresh_token` scoped to
`/api/v1/auth` (and in the response body for non-browser clients). The gateway applies the strict
rate limit (20/min/IP) to login, register, refresh and password-reset routes.

## Register and login

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant G as api-gateway
    participant A as auth-service
    participant DB as auth_db
    participant MQ as domain.events

    C->>G: POST /api/v1/auth/register (email, password, displayName)
    G->>A: proxy (strict rate limit 20/min/IP)
    A->>A: Argon2id hash (19 MiB, t=2, p=1)
    A->>DB: tx: credential + new token family + UserRegistered and UserLoggedIn outbox rows
    A-->>C: 201 access token + refresh cookie
    Note over MQ: UserRegistered → user-service (profile) and<br/>notification-service (recipient + welcome email)

    C->>G: POST /api/v1/auth/login
    G->>A: proxy
    alt account locked (5 failures → 15 min)
        A-->>C: 429 account_locked + Retry-After
    else wrong password or inactive account
        A->>DB: failed_login_count + 1, LoginFailed outbox row
        A-->>C: 401 invalid credentials (same message for unknown email)
    else valid
        A->>DB: tx: reset counter, new family, store SHA-256(refresh), UserLoggedIn outbox row
        A-->>C: 200 access token (15 min) + refresh cookie
    end
```

## Refresh-token rotation with reuse detection

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant X as Attacker with a copied token
    participant A as auth-service
    participant DB as auth_db
    participant MQ as domain.events

    C->>A: POST /api/v1/auth/refresh (cookie R1)
    A->>DB: R1 valid → revoke R1 (rotated, replaced_by R2), insert R2 in the same family
    A-->>C: new access token + R2
    X->>A: POST /api/v1/auth/refresh (copied R1)
    A->>DB: R1 already revoked → revoke every token in the family (reuse_detected)
    A->>DB: RefreshTokenReuseDetected outbox row
    A-->>X: 401 problem+json
    Note over MQ: RefreshTokenReuseDetected → audit-service
    C->>A: POST /api/v1/auth/refresh (R2)
    A-->>C: 401 — session revoked, user must log in again
```

![Animated refresh-token rotation: login issues R1, refresh rotates R1 to R2, replaying R1 revokes the whole family and is audited](../assets/animated/auth-refresh-rotation.svg)

_Animated preview (CSS animation). The Mermaid diagrams on this page are the static, accessible
alternative._

## Logout, password reset and account status

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as auth-service
    participant DB as auth_db
    participant MQ as domain.events
    participant N as notification-service
    participant U as user-service

    C->>A: POST /api/v1/auth/logout (refresh cookie)
    A->>DB: revoke the token family (idempotent), UserLoggedOut outbox row
    A-->>C: 204 + cleared cookie

    C->>A: POST /api/v1/auth/password-reset/request (email)
    opt account exists
        A->>DB: single-use reset token, SHA-256 hash, expires in 15 min
        A->>DB: PasswordResetRequested + NotificationRequested outbox rows<br/>(template password-reset, sensitiveDataKeys resetUrl)
    end
    A-->>C: 202 always (no account enumeration)
    MQ-)N: NotificationRequested → email via SMTP, then resetUrl is scrubbed
    C->>A: POST /api/v1/auth/password-reset/confirm (token, newPassword)
    A->>DB: consume token, new Argon2id hash, revoke all sessions, PasswordChanged
    A-->>C: 204 + cleared cookie

    U-)MQ: UserStatusChanged (admin suspends or closes an account)
    MQ-)A: UserStatusChanged → block login and revoke all sessions
```

## How services verify tokens (JWKS)

No service calls auth-service per request. `@emb/security` verifies each bearer token locally
against the JWKS published by auth-service.

```mermaid
flowchart LR
    req["request with<br/>Authorization: Bearer token"] --> mw["authenticate middleware<br/>@emb/security"]
    mw --> cache{"key for kid<br/>in JWKS cache?"}
    cache -->|"yes"| verify["jwtVerify ES256<br/>iss · aud · exp · typ at+jwt<br/>sub · sid · jti · 5 s clock tolerance"]
    cache -->|"no"| fetch["GET auth-service /.well-known/jwks.json<br/>3 s timeout · 30 s cooldown"]
    fetch --> verify
    fetch -->|"JWKS unreachable"| unavailable["503 problem+json<br/>fail closed"]
    verify -->|"valid"| principal["req.auth = userId, roles, sessionId<br/>requireRoles / owner checks"]
    verify -->|"invalid or expired"| unauthorized["401 problem+json"]
```

Service-to-service calls (`/internal/*`) do not use JWTs: they require the shared
`x-internal-token` header, which the gateway strips from every inbound request.
