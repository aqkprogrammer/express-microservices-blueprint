# Threat model

A concise STRIDE review of the blueprint as it runs in Docker Compose. "Implemented" refers to code in this repository; "Gap / recommendation" lists what a production deployment should add. See the [security model](README.md) for the full list of controls.

## Scope and assets

| Asset                                                   | Where                                                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Credentials (password hashes), refresh and reset tokens | `auth_db`                                                                                      |
| JWT signing key                                         | `jwt-keys` volume / secret file                                                                |
| Personal data (email, display name, order history)      | `auth_db`, `users_db`, `notification_db`, `orders_db`, `payment_db`, dead-letter archive, logs |
| Money-related state (payments, refunds)                 | `payment_db` (simulated)                                                                       |
| Stock and order integrity                               | `inventory_db`, `orders_db`                                                                    |
| Audit trail                                             | `audit_db`                                                                                     |
| Service-to-service credential                           | `INTERNAL_API_TOKEN`                                                                           |

Entry points: the API gateway (`:8080`), the worker admin API (`127.0.0.1:3009`), operator UIs bound to localhost (RabbitMQ, Grafana, Prometheus, Jaeger, Mailpit), and the message bus for anyone with broker credentials.

## STRIDE

| Threat                                                   | Example                                                            | Implemented mitigations                                                                                                                          | Gap / recommendation                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Spoofing** — user                                      | Credential stuffing, stolen access token                           | Argon2id, lockout after 5 failures, strict rate limit on credential endpoints, 15-min ES256 access tokens, refresh rotation with reuse detection | MFA/passkeys via an IdP; breached-password checks; bot protection                                                                        |
| **Spoofing** — service                                   | Client calls `/internal/*` or forges `x-internal-token`            | Internal paths not routable; header stripped at the gateway; constant-time token check                                                           | Shared static token for all services → per-service identity (mTLS, workload identity)                                                    |
| **Spoofing** — tokens                                    | Algorithm confusion, foreign issuer                                | ES256 only, issuer, audience, `typ` and required claims verified                                                                                 | —                                                                                                                                        |
| **Tampering** — requests                                 | Path traversal to internal routes, oversized or malformed bodies   | Path normalisation (`invalid_path`), origin check, Zod validation, body limits                                                                   | WAF at the edge                                                                                                                          |
| **Tampering** — data                                     | Overselling, double payment, concurrent edits                      | Conditional updates, `CHECK`/unique constraints, row locks, optimistic concurrency (`expectedVersion`), idempotency keys                         | —                                                                                                                                        |
| **Tampering** — messages                                 | Malformed or forged events on the bus                              | Envelope + payload validation, poison messages dead-lettered                                                                                     | Shared broker user → per-service RabbitMQ users with publish/consume permissions; TLS to the broker                                      |
| **Repudiation**                                          | Admin denies changing a user's status or refunding                 | Append-only audit records with actor IDs; `payment_events`; `stock_adjustments` with actor; request/correlation IDs in logs                      | Ship audit data to write-once storage; time synchronisation and log integrity controls                                                   |
| **Information disclosure** — API                         | Enumerating others' orders, account existence                      | 404 for others' orders/payments; generic login errors with timing equalisation; output DTOs; problem details without internals                   | Registration reveals existing emails (`email_taken`) — add verification flows if needed                                                  |
| **Information disclosure** — data at rest and in transit | Dumps, logs, plain-text internal traffic                           | Hashes for secrets, log redaction, audit allow-list, scrubbing of reset links, no card data, `.gitignore` for dumps                              | TLS for all internal connections; encryption at rest; dead-letter retention policy; access control on observability tools                |
| **Denial of service**                                    | Request floods, slow upstreams, poison messages, targeted lockouts | Rate limits (fail-open), body limits, timeouts, circuit breakers, bounded prefetch and DB pools, statement timeout, delivery limits, DLQ         | Edge DDoS protection; per-user limits; lockout abuse can block a known account for 15 min                                                |
| **Elevation of privilege**                               | Customer calls admin APIs; service reads another service's DB      | Role checks in each service; least-privilege DB roles with `CONNECT` revoked; non-root containers; no Prisma CLI or DDL rights at runtime        | Admin actions limited to RBAC (no step-up auth); container hardening (read-only root FS, dropped capabilities) in orchestrator manifests |

## Highest residual risks

1. **Plain-text internal traffic and a shared internal token** — acceptable on a laptop, not in a shared network.
2. **Access tokens valid up to 15 minutes after revocation** — no denylist.
3. **Fail-open rate limiting** during Redis outages.
4. **Personal data outside primary stores** — dead letters (no automatic deletion), logs, backups.
5. **Reference authentication** instead of a hardened identity provider ([ADR-0015](../decisions/0015-reference-authentication-vs-identity-provider.md)).

Revisit this model when adding a service, a public endpoint, a new data store or a real payment provider.
