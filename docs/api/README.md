# API guide

All public traffic goes through the API gateway at `http://localhost:8080`. Interactive documentation for every service is served by the gateway at **<http://localhost:8080/docs>** (Swagger UI with one entry per service). The OpenAPI 3.1 documents are also committed in [`docs/api/openapi/`](openapi/) and regenerated with `npm run docs:openapi`.

Errors use RFC 9457 problem details; every code is listed in the [error catalogue](errors.md).

## Endpoint classification

### Public (no authentication)

| Method | Path                                  | Service | Notes                                                                                             |
| ------ | ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `GET`  | `/.well-known/jwks.json`              | auth    | Public signing keys                                                                               |
| `POST` | `/api/v1/auth/register`               | auth    | Strict rate limit                                                                                 |
| `POST` | `/api/v1/auth/login`                  | auth    | Strict rate limit                                                                                 |
| `POST` | `/api/v1/auth/refresh`                | auth    | Refresh token from cookie or body; strict rate limit                                              |
| `POST` | `/api/v1/auth/logout`                 | auth    | Refresh token from cookie or body                                                                 |
| `POST` | `/api/v1/auth/password-reset/request` | auth    | Always `202`; strict rate limit                                                                   |
| `POST` | `/api/v1/auth/password-reset/confirm` | auth    | Strict rate limit                                                                                 |
| `GET`  | `/api/v1/products`                    | product | Active products only; authentication optional (admins also see drafts and can filter by `status`) |
| `GET`  | `/api/v1/products/{productId}`        | product | Drafts return 404 unless admin                                                                    |
| `GET`  | `/docs`, `/docs/specs/{service}.json` | gateway | Swagger UI and specs                                                                              |
| `GET`  | `/health/live`, `/health/ready`       | gateway | The gateway's own health                                                                          |

### Authenticated (any role; `Authorization: Bearer <access token>`)

| Method         | Path                                                           | Service      | Authorization                                                                             |
| -------------- | -------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `GET`          | `/api/v1/auth/me`                                              | auth         | Token claims                                                                              |
| `GET`, `PATCH` | `/api/v1/users/me`                                             | user         | Own profile                                                                               |
| `GET`          | `/api/v1/users/{userId}`                                       | user         | Self or admin (403 otherwise)                                                             |
| `POST`         | `/api/v1/orders`                                               | order        | `Idempotency-Key` required                                                                |
| `GET`          | `/api/v1/orders`                                               | order        | Own orders; admins see all and may filter by `customerId`                                 |
| `GET`          | `/api/v1/orders/{orderId}`, `/api/v1/orders/{orderId}/history` | order        | Owner or admin (404 otherwise)                                                            |
| `POST`         | `/api/v1/orders/{orderId}/cancel`                              | order        | Owner (in `PENDING`, `AWAITING_PAYMENT`, `CONFIRMED`) or admin (any non-cancelled status) |
| `GET`          | `/api/v1/payments?orderId=`                                    | payment      | Owner or admin (empty list otherwise)                                                     |
| `GET`          | `/api/v1/payments/{paymentId}`                                 | payment      | Owner or admin (404 otherwise)                                                            |
| `GET`          | `/api/v1/notifications`                                        | notification | Own notifications; admins may filter by `recipientUserId` and `status`                    |

### Admin (role `admin`, through the gateway)

| Method        | Path                                                                                                    | Service      |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| `GET`         | `/api/v1/users` (`q`, `status`, `sort` = `newest`/`oldest`/`email`)                                     | user         |
| `PATCH`       | `/api/v1/users/{userId}/status`                                                                         | user         |
| `POST`        | `/api/v1/products`                                                                                      | product      |
| `PATCH`       | `/api/v1/products/{productId}`                                                                          | product      |
| `GET`, `POST` | `/api/v1/inventory` (`lowStockThreshold`)                                                               | inventory    |
| `GET`         | `/api/v1/inventory/{productId}`                                                                         | inventory    |
| `POST`        | `/api/v1/inventory/{productId}/adjustments`                                                             | inventory    |
| `GET`         | `/api/v1/inventory/reservations/{orderId}`                                                              | inventory    |
| `POST`        | `/api/v1/payments/intents` (`Idempotency-Key` required)                                                 | payment      |
| `POST`        | `/api/v1/payments/{paymentId}/capture`                                                                  | payment      |
| `POST`        | `/api/v1/payments/{paymentId}/refund` (`Idempotency-Key` required)                                      | payment      |
| `GET`         | `/api/v1/notifications/templates`                                                                       | notification |
| `PUT`         | `/api/v1/notifications/templates/{key}`                                                                 | notification |
| `GET`         | `/api/v1/audit-events` (`eventType`, `category`, `subjectId`, `actorId`, `correlationId`, `from`, `to`) | audit        |

### Admin, not routed by the gateway

| Method | Path                                                                             | Where                           |
| ------ | -------------------------------------------------------------------------------- | ------------------------------- |
| `GET`  | `/admin/v1/dead-letters` (`status` = `ARCHIVED`/`REPLAYED`/`DISCARDED`, `queue`) | worker, `http://127.0.0.1:3009` |
| `GET`  | `/admin/v1/dead-letters/{id}`                                                    | worker                          |
| `POST` | `/admin/v1/dead-letters/{id}/replay`                                             | worker                          |
| `POST` | `/admin/v1/dead-letters/{id}/discard`                                            | worker                          |

Requires an admin access token. See the [runbook](../operations/runbook.md#dead-letters).

### Internal (service-to-service only)

Never routed by the gateway; require the `x-internal-token` header.

| Method | Path                                            | Service | Caller                              |
| ------ | ----------------------------------------------- | ------- | ----------------------------------- |
| `GET`  | `/internal/v1/products?ids=<uuid,…>` (1–50 IDs) | product | order-service (price snapshots)     |
| `GET`  | `/internal/v1/payments/by-order/{orderId}`      | payment | order-service (saga reconciliation) |

Every service also serves `/health/live`, `/health/ready`, `/metrics` and `/openapi.json` on the private network only.

## Authentication

```sh
# Register (201) — or log in (200) — and keep the access token
curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.test","password":"correct-horse-battery","displayName":"Alice"}'

TOKEN=$(curl -s -c cookies.txt -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.test","password":"correct-horse-battery"}' | jq -r .accessToken)

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/auth/me
```

Token response:

```json
{
  "accessToken": "eyJhbGciOiJFUzI1NiIs…",
  "tokenType": "Bearer",
  "expiresIn": 900,
  "refreshToken": "…",
  "refreshTokenExpiresAt": "2026-10-23T10:00:00.000Z",
  "user": { "id": "…", "email": "alice@example.test", "roles": ["customer"] }
}
```

Refresh and logout use the `emb_refresh_token` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/api/v1/auth`) or a `refreshToken` field in the body:

```sh
curl -s -b cookies.txt -c cookies.txt -X POST http://localhost:8080/api/v1/auth/refresh | jq -r .accessToken
curl -s -X POST http://localhost:8080/api/v1/auth/refresh -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<refresh token>"}'
curl -s -b cookies.txt -X POST http://localhost:8080/api/v1/auth/logout -o /dev/null -w '%{http_code}\n'   # 204
```

Each refresh returns a new refresh token; reusing an old one revokes the session. Passwords need 12–128 characters. Details: [authentication](../security/authentication.md).

Password reset:

```sh
curl -s -X POST http://localhost:8080/api/v1/auth/password-reset/request \
  -H 'Content-Type: application/json' -d '{"email":"alice@example.test"}'          # 202
# Take the token from the link in the email (Mailpit, http://localhost:8025)
curl -s -X POST http://localhost:8080/api/v1/auth/password-reset/confirm \
  -H 'Content-Type: application/json' -d '{"token":"<token>","newPassword":"another-long-passphrase"}'   # 204
```

## Catalog

```sh
curl -s 'http://localhost:8080/api/v1/products?q=keyboard&inStock=true&sort=price&page=1&pageSize=10' | jq
curl -s http://localhost:8080/api/v1/products/0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001 | jq
```

Filters: `q` (name search), `category`, `minPriceCents`, `maxPriceCents`, `inStock` (`true`/`false`), `status` (admins only), `sort` = `newest` (default), `price`, `-price`, `name`, `-name`. Product responses include `price {amountCents, currency}`, `availability {availableQuantity, inStock, updatedAt}` and `version`. Availability is a read model updated from inventory events and can lag briefly.

## Orders

```sh
KEY=$(uuidgen)
curl -s -i -X POST http://localhost:8080/api/v1/orders \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  -d '{"lines":[{"productId":"0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001","quantity":1},
                {"productId":"0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2002","quantity":2}],
       "paymentMethodToken":"sim_card_approved"}'
```

- `201 Created`, `Location: /api/v1/orders/{id}`, `Idempotent-Replayed: false`, body = order with `status: "PENDING"`, price snapshots per line, `totalCents`, `currency`, and `saga {step, deadlineAt, paymentAttempts}`.
- The order then progresses asynchronously: `PENDING → AWAITING_PAYMENT → CONFIRMED`, or `CANCELLED` (`cancellationReason`), or `REQUIRES_REVIEW` (`reviewReason`). Poll `GET /api/v1/orders/{id}`.
- Lines: 1–100 entries, quantity 1–100; repeated products are merged; at most 20 distinct products (`MAX_ORDER_LINES`). All products must be `active` and share one currency.
- `paymentMethodToken` is a **simulator token** (default `sim_card_approved`); real card data is never accepted.

```sh
curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:8080/api/v1/orders?status=CONFIRMED&page=1&pageSize=20' | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/orders/<orderId>/history | jq
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/orders/<orderId>/cancel | jq
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/v1/payments?orderId=<orderId>" | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/notifications | jq
```

Cancelling a confirmed order refunds the captured payment and restocks the items.

### Trying failure scenarios

| Scenario                                             | How                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declined payment → cancellation and stock release    | `"paymentMethodToken":"sim_card_declined"` (or `sim_insufficient_funds`)                                                                                                        |
| Transient provider errors → message retries          | `"paymentMethodToken":"sim_transient_error"`                                                                                                                                    |
| Provider timeout → reconciliation instead of failure | `"paymentMethodToken":"sim_provider_timeout"` (confirms after the reconciliation described in [troubleshooting](../troubleshooting/README.md#orders-stuck-in-awaiting_payment)) |
| Out of stock                                         | Order 2 units of `0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2008` (`LT-LIMIT-008`, 1 unit in stock)                                                                                       |
| Failing email delivery → retries and dead letter     | Register a user with an `@bounce.test` address                                                                                                                                  |

## Administration

```sh
ADMIN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.test","password":"local-dev-admin-password"}' | jq -r .accessToken)

# Create a product (starts as draft unless status is given) and update it with optimistic concurrency
curl -s -X POST http://localhost:8080/api/v1/products -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"sku":"MUG-COFFEE-009","name":"Coffee mug","category":"kitchen","priceCents":1500,"currency":"USD","status":"active"}'
curl -s -X PATCH http://localhost:8080/api/v1/products/<productId> -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"priceCents":1400,"expectedVersion":1}'

# Stock (inventory records are created automatically from ProductCreated)
curl -s -X POST http://localhost:8080/api/v1/inventory/<productId>/adjustments -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"delta":50,"reason":"initial delivery"}'
curl -s -H "Authorization: Bearer $ADMIN" 'http://localhost:8080/api/v1/inventory?lowStockThreshold=5' | jq

# Users
curl -s -H "Authorization: Bearer $ADMIN" 'http://localhost:8080/api/v1/users?q=alice&status=active' | jq
curl -s -X PATCH http://localhost:8080/api/v1/users/<userId>/status -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"suspended","reason":"chargeback investigation"}'

# Payments back office (Idempotency-Key required)
curl -s -X POST http://localhost:8080/api/v1/payments/<paymentId>/refund -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d '{"amountCents":500,"reason":"damaged item"}'

# Audit trail
curl -s -H "Authorization: Bearer $ADMIN" 'http://localhost:8080/api/v1/audit-events?category=security&pageSize=50' | jq
```

## Pagination

List endpoints accept `page` (1–10 000, default 1) and `pageSize` (1–100, default 20) and return:

```json
{
  "data": [ … ],
  "pagination": { "page": 1, "pageSize": 20, "totalItems": 57, "totalPages": 3 }
}
```

Paginated: products, users, orders, inventory, notifications, audit events, dead letters. `GET /api/v1/payments?orderId=` and `GET /api/v1/notifications/templates` return `{ "data": [ … ] }` without pagination.

## Idempotency-Key

Required on `POST /api/v1/orders`, `POST /api/v1/payments/intents` and `POST /api/v1/payments/{id}/refund`.

| Rule                            | Behaviour                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Format                          | 8–128 characters of `A–Z a–z 0–9 _ -`; use a UUID. Missing or malformed → `400 validation_failed`           |
| Scope                           | Per caller (and per operation/payment for payments). The same key from different users never collides.      |
| Same key, same request          | Original result returned; `Idempotent-Replayed: true` (orders: `200` instead of `201`)                      |
| Same key, different request     | `422 idempotency_key_reused`                                                                                |
| Concurrent duplicate (payments) | `409 idempotency_in_progress` — retry after a short delay                                                   |
| Failed operation (payments)     | Key released; retrying with the same key runs the operation again                                           |
| Lifetime                        | Orders: as long as the order exists. Payments: stored responses kept 24 h, after which the key is forgotten |

Generate a new key for every new intent; reuse the same key only when retrying the same request after a timeout or network error. Rationale: [ADR-0011](../decisions/0011-idempotency.md).

## Rate limits

The gateway limits requests per client IP over a 60 s window: **300** for all routes and, additionally, **20** for login, register, refresh and password reset. Responses carry IETF draft-8 headers, for example:

```text
RateLimit: "300-in-1min"; r=297; t=42
RateLimit-Policy: "300-in-1min"; q=300; w=60; pk=:…:
```

Credential endpoints carry one entry per limiter. When a limit is exceeded the gateway answers `429 rate_limited` with `Retry-After` (seconds). Separately, auth-service locks an account for 15 minutes after 5 failed logins (`429 account_locked`, with `Retry-After`). For browser clients on other origins, CORS exposes `X-Request-Id`, `X-Correlation-Id`, `Retry-After` and `Location`, but not the `RateLimit` headers. If Redis is unavailable the limits are not enforced (fail-open).

## Common headers

| Header                             | Direction | Meaning                                                                                                                                 |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer …`          | request   | Access token                                                                                                                            |
| `Idempotency-Key`                  | request   | See above                                                                                                                               |
| `X-Request-Id`, `X-Correlation-Id` | both      | Accepted if they match `^[A-Za-z0-9._:-]{1,128}$`, otherwise generated; always returned. Quote `X-Request-Id` when reporting a problem. |
| `Idempotent-Replayed`              | response  | `true` when a stored result was returned                                                                                                |
| `Location`                         | response  | URL of a created resource                                                                                                               |
| `Retry-After`                      | response  | On `429` and `503`                                                                                                                      |

Request bodies are JSON (`Content-Type: application/json`), limited to 256 kB at the gateway and 100 kB per service.
