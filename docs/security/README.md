# Security model

This page lists the security controls that are **implemented** in the code, where they live, and — just as important — what is **not** implemented or claimed. Related pages: [authentication](authentication.md), [payments](payments.md), [threat model](threat-model.md).

> This repository is a blueprint. It applies widely accepted practices, but it has not been independently audited or penetration-tested, it is **not "fully secure"**, and it makes **no compliance claims** (no PCI DSS, SOC 2, ISO 27001, HIPAA or GDPR certification). Review and adapt it before handling real users, money or personal data.

## Trust boundaries

```text
Internet ──▶ API gateway (:8080) ──▶ services (private network) ──▶ PostgreSQL / RabbitMQ / Redis
              public edge             verify JWTs themselves         one DB + role per service
```

- Only the gateway is meant to be reachable by clients. In Docker Compose every published port is bound to `127.0.0.1`; databases, the broker and service ports are not published at all.
- Services do **not** trust the gateway for identity: each one verifies the bearer token itself.
- `/internal/*` endpoints are for service-to-service calls only: not routable through the gateway and additionally guarded by a shared `x-internal-token`.

## Implemented controls

### Edge (API gateway)

| Control                       | Details                                                                                                                                           | Code                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Explicit route allow-list     | Unlisted paths (all `/internal/*`, `/admin/*`, service `/metrics` and `/health/*`) return 404                                                     | `apps/api-gateway/src/routes.ts` |
| Path normalisation            | Rejects `%2e`, `%2f`, `%5c`, `\`, `.` and `..` segments (`400 invalid_path`); collapses `//`; verifies the upstream URL keeps the upstream origin | `routes.ts`, `proxy.ts`          |
| Header stripping              | Removes client-supplied `x-internal-token`, `x-forwarded-*`, `forwarded`, `traceparent`, `tracestate` and hop-by-hop headers                      | `apps/api-gateway/src/proxy.ts`  |
| Rate limiting                 | 300 req/min/IP globally, 20 req/min/IP on login, register, refresh and password reset; Redis-backed, **fail-open**                                | `apps/api-gateway/src/app.ts`    |
| Body limit                    | 256 kB at the gateway (`413 payload_too_large`)                                                                                                   | `HTTP_BODY_LIMIT`                |
| Timeouts and circuit breakers | 10 s upstream timeout; per-upstream breaker (5 failures → open 10 s); no automatic retries of client requests                                     | `proxy.ts`                       |
| Metrics not public            | Gateway metrics on internal port 9464 only                                                                                                        | `buildMetricsApp`                |

### Every service (`createServiceApp`)

| Control                  | Details                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security headers         | `helmet()` defaults (CSP, `X-Content-Type-Options`, frame protections, HSTS, …); `X-Powered-By` disabled                                                                                                   |
| CORS allow-list          | Exact-match origins from `CORS_ALLOWED_ORIGINS`; no wildcard; credentials allowed only for listed origins                                                                                                  |
| Input validation         | Zod schemas for body, query, path params and headers (`parseWith`); unknown query structure prevented by the `simple` query parser; JSON only for `application/json` and `application/*+json`, strict mode |
| Body limit               | 100 kB default per service (`HTTP_BODY_LIMIT`)                                                                                                                                                             |
| Output shaping           | Explicit DTO mappers: e.g. payment responses never include the method token or provider reference; dead-letter lists omit bodies; users see a reduced profile, admins an extended one                      |
| Errors without internals | RFC 9457 problem documents; for 5xx the `detail` is omitted unless deliberately exposed; stack traces never leave the process; health-check errors are truncated                                           |
| Request IDs              | Caller-supplied `X-Request-Id`/`X-Correlation-Id` accepted only if they match `^[A-Za-z0-9._:-]{1,128}$`                                                                                                   |
| Log redaction            | Passwords, tokens, secrets, `authorization`, `cookie`, `set-cookie`, `x-internal-token` replaced with `[REDACTED]`                                                                                         |

### Authentication and authorization

| Control                               | Details                                                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token verification in every service   | ES256 only, issuer, audience, expiry, `typ: at+jwt`, required claims; JWKS fetched and cached; JWKS unreachable → `503` (fail closed)                                                                                                           |
| RBAC                                  | Roles `customer` and `admin` (`requireRoles`); admin-only APIs: inventory, product writes, user administration, payment back-office operations, notification templates, audit events, dead-letter administration                                |
| Resource-level authorization          | Orders and payments of other customers return **404** (not 403) to avoid revealing existence; payment lists for another customer's order are empty; notifications are scoped to the caller; `GET /api/v1/users/{id}` returns 403 for non-owners |
| Internal endpoints                    | `x-internal-token` compared in constant time (SHA-256 + `timingSafeEqual`)                                                                                                                                                                      |
| Credentials, sessions, lockout, reset | See [authentication](authentication.md)                                                                                                                                                                                                         |
| Refresh-token cookie                  | `HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`, `Secure` when `COOKIE_SECURE=true` (the default; Compose sets `false` for plain-HTTP localhost)                                                                                             |

### Data

| Control                       | Details                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database least privilege      | One database and role per service, `NOSUPERUSER NOCREATEDB NOCREATEROLE`, `CONNECT` revoked from `PUBLIC` ([ADR-0004](../decisions/0004-database-per-service.md)) |
| Integrity constraints         | `CHECK` constraints and unique keys guard invariants regardless of application bugs                                                                               |
| Only hashes of secrets stored | Passwords (Argon2id), refresh and reset tokens (SHA-256)                                                                                                          |
| No card data                  | Payment method is a simulator token; a database `CHECK` rejects anything not matching `^sim_[a-z_]+$` ([payments](payments.md))                                   |
| Audit trail                   | Append-only `audit_records` (trigger blocks `UPDATE`), allow-listed fields only, values that look like credentials dropped                                        |
| Sensitive notification data   | Fields marked sensitive (password-reset link) are scrubbed after delivery or final failure                                                                        |
| Retention                     | See [data retention](../operations/data-retention.md)                                                                                                             |

### Supply chain and runtime

| Control                       | Details                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-root containers           | Runtime images run as `node` (uid 1000)                                                                                                                                                                                                                    |
| Minimal images                | `node:24-alpine`; production dependencies of one workspace only; no TypeScript sources, tests, source maps or the `@emb/testing` package                                                                                                                   |
| No Prisma CLI at runtime      | Migrations run in a separate one-shot `migrator` image ([ADR-0004](../decisions/0004-database-per-service.md))                                                                                                                                             |
| Secrets via files             | Any declared config variable can be supplied as `<NAME>_FILE` (Docker/Kubernetes secrets); explicit values win; config errors name the variable but never echo its value                                                                                   |
| Build-time CA without leaking | Corporate CA bundles are passed as a BuildKit secret (`EXTRA_CA_FILE`) and never stored in an image layer                                                                                                                                                  |
| Lockfile installs             | `npm ci` from `package-lock.json`                                                                                                                                                                                                                          |
| Outbound HTTP (SSRF guard)    | `ServiceClient` accepts only relative paths (no absolute URLs, `//` or `..`), resolves them against a fixed configured origin and rejects any result on another origin, refuses non-HTTP(S) base URLs, and does not follow redirects (`redirect: 'error'`) |
| Graceful shutdown             | SIGTERM drains HTTP and consumers; readiness reports 503 while draining                                                                                                                                                                                    |

## Limitations and what is not claimed

| Area                                    | Status                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport encryption inside the network | **Not implemented.** Service-to-service HTTP, PostgreSQL, RabbitMQ and Redis connections are plain text in Compose. Use TLS (or a service mesh with mTLS) in production.                |
| TLS at the edge                         | Not provided by the gateway; terminate TLS at a load balancer or ingress.                                                                                                               |
| Service identity                        | One **shared** static `INTERNAL_API_TOKEN` for all services; no per-service identity or mTLS.                                                                                           |
| Broker and cache credentials            | All services share one RabbitMQ user; Redis has no authentication locally.                                                                                                              |
| Access-token revocation                 | No denylist: an access token stays valid until it expires (≤ 15 min) after logout, password reset or suspension.                                                                        |
| MFA, passkeys, federation               | Not implemented — see [ADR-0015](../decisions/0015-reference-authentication-vs-identity-provider.md).                                                                                   |
| CSRF tokens                             | Not implemented. Protection relies on bearer tokens in the `Authorization` header for API calls and on `SameSite=Strict` + path scoping for the refresh cookie.                         |
| Rate limiting when Redis is down        | Fails open (documented trade-off, [ADR-0007](../decisions/0007-redis-not-system-of-record.md)). Account lockout still applies.                                                          |
| WAF, bot protection, DDoS protection    | Not provided.                                                                                                                                                                           |
| Secret management                       | `*_FILE` support only; no integration with a vault/KMS; local defaults in `docker-compose.yml` are synthetic and must never be used elsewhere.                                          |
| Operational endpoints                   | `/health/*`, `/metrics` and `/openapi.json` are unauthenticated on the private network; Swagger UI (`/docs`) is enabled by default (`DOCS_ENABLED`). Restrict or disable in production. |
| Compliance                              | No PCI DSS scope assessment, no GDPR erasure/export workflow, no data-residency controls.                                                                                               |
| Security testing                        | Unit tests cover selected controls (e.g. `packages/security/src/security.test.ts`, gateway route tests). No external audit, fuzzing or penetration test results are published.          |

## Reporting

If you find a vulnerability in this blueprint, please report it privately to the maintainers rather than opening a public issue.
