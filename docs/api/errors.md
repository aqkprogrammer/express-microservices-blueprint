# Error catalogue

Every error response — from the gateway and from every service — is an **RFC 9457 problem document** with `Content-Type: application/problem+json`. The `type` URI points to the matching section of this page (`…/docs/api/errors.md#<code>`), and `code` repeats the stable, machine-readable identifier. Clients should branch on `code` (or `status`), never on `detail` text.

```json
{
  "type": "https://github.com/aqkprogrammer/express-microservices-blueprint/blob/main/docs/api/errors.md#validation_failed",
  "title": "Bad Request",
  "status": 400,
  "code": "validation_failed",
  "detail": "Invalid request body",
  "instance": "/api/v1/orders",
  "requestId": "6f1c2e0a-8a51-4d0e-9a57-2a7c0f6f3b9e",
  "errors": [{ "path": "body.lines.0.quantity", "message": "Too small: expected number to be >=1" }]
}
```

| Field                             | Present                                                        | Meaning                                                                                         |
| --------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `type`, `title`, `status`, `code` | always                                                         | `title` is the standard reason phrase for `status`                                              |
| `detail`                          | for 4xx and for deliberately exposed 5xx (`502`, `503`, `504`) | Human-readable explanation; never contains stack traces or internal details. Omitted for `500`. |
| `instance`                        | always                                                         | Request path (without query string)                                                             |
| `requestId`                       | always                                                         | Same as the `X-Request-Id` response header; quote it when reporting a problem                   |
| `errors`                          | `validation_failed` only                                       | Field-level problems: `path` is prefixed with `body`, `query`, `params` or `headers`            |

Some errors add headers: `WWW-Authenticate: Bearer` (401), `Retry-After` (429, 503). The gateway relays problem documents from services unchanged.

## Index

| Code                                                    | Status             | Raised by                               |
| ------------------------------------------------------- | ------------------ | --------------------------------------- |
| [validation_failed](#validation_failed)                 | 400                | all services                            |
| [malformed_json](#malformed_json)                       | 400                | all services                            |
| [bad_request](#bad_request)                             | 400 (or other 4xx) | all services, gateway                   |
| [invalid_path](#invalid_path)                           | 400                | gateway                                 |
| [invalid_reset_token](#invalid_reset_token)             | 400                | auth                                    |
| [unauthorized](#unauthorized)                           | 401                | all services                            |
| [forbidden](#forbidden)                                 | 403                | all services                            |
| [not_found](#not_found)                                 | 404                | all services, gateway                   |
| [conflict](#conflict)                                   | 409                | inventory                               |
| [email_taken](#email_taken)                             | 409                | auth                                    |
| [duplicate_sku](#duplicate_sku)                         | 409                | product                                 |
| [version_conflict](#version_conflict)                   | 409                | product, notification                   |
| [invalid_order_state](#invalid_order_state)             | 409                | order                                   |
| [idempotency_in_progress](#idempotency_in_progress)     | 409                | payment                                 |
| [idempotency_conflict](#idempotency_conflict)           | 409                | payment                                 |
| [payment_exists](#payment_exists)                       | 409                | payment                                 |
| [invalid_payment_state](#invalid_payment_state)         | 409                | payment                                 |
| [account_inactive](#account_inactive)                   | 409                | user                                    |
| [invalid_dead_letter_state](#invalid_dead_letter_state) | 409                | worker                                  |
| [unknown_queue](#unknown_queue)                         | 409                | worker                                  |
| [payload_too_large](#payload_too_large)                 | 413                | all services, gateway                   |
| [unprocessable](#unprocessable)                         | 422                | order                                   |
| [invalid_status_transition](#invalid_status_transition) | 422                | product                                 |
| [insufficient_stock](#insufficient_stock)               | 422                | inventory                               |
| [unknown_product](#unknown_product)                     | 422                | order                                   |
| [product_unavailable](#product_unavailable)             | 422                | order                                   |
| [mixed_currency](#mixed_currency)                       | 422                | order                                   |
| [idempotency_key_reused](#idempotency_key_reused)       | 422                | order, payment                          |
| [invalid_refund_amount](#invalid_refund_amount)         | 422                | payment                                 |
| [invalid_status_change](#invalid_status_change)         | 422                | user                                    |
| [unknown_placeholder](#unknown_placeholder)             | 422                | notification                            |
| [rate_limited](#rate_limited)                           | 429                | gateway                                 |
| [account_locked](#account_locked)                       | 429                | auth                                    |
| [internal_error](#internal_error)                       | 500                | all services                            |
| [upstream_error](#upstream_error)                       | 502 / 504          | services calling other services (order) |
| [upstream_unreachable](#upstream_unreachable)           | 502                | gateway                                 |
| [service_unavailable](#service_unavailable)             | 503                | gateway, services                       |
| [upstream_timeout](#upstream_timeout)                   | 504                | gateway                                 |

Sections below are grouped by origin: general codes first, then gateway, auth, user, product, inventory, order, payment, notification and worker codes.

Business failures that happen asynchronously (e.g. an order cancelled because stock ran out or payment was declined) are **not** HTTP errors: the order's `status`, `cancellationReason` and `reviewReason` report them.

## validation_failed

**400** — the request body, query string, path parameters or a header did not match the schema. `errors` lists each problem, e.g. `body.lines.0.productId`, `query.pageSize`, `params.orderId`, `headers` (malformed `Idempotency-Key`). A missing `Idempotency-Key` on an endpoint that requires it also returns this code (without `errors`). Fix the request; retrying unchanged will fail again.

## malformed_json

**400** — the body is not valid JSON (or not a JSON object/array in strict mode). Check the `Content-Type: application/json` body.

## bad_request

**400**, or the status reported by the body parser (e.g. **415** for an unsupported charset or content encoding) — the request body could not be read. The gateway also uses `400 bad_request` if a request would resolve to a URL outside the upstream's origin (defence in depth; normally caught earlier as `invalid_path`).

## unauthorized

**401**, with `WWW-Authenticate: Bearer` — authentication is missing or failed:

- no `Authorization: Bearer` header, or a malformed one;
- the access token is invalid (`Token is invalid`), expired (`Token has expired`) or lacks required claims;
- wrong email or password, or an inactive account, on login (`Invalid email or password` — deliberately the same message for every case);
- refresh token missing, expired, revoked or reused (`Refresh token is no longer valid`);
- `/internal/*` called without a valid `x-internal-token`.

Refresh the access token (`POST /api/v1/auth/refresh`) or log in again. If refreshing also fails with 401, the session was revoked.

## forbidden

**403** — authenticated, but not allowed: the endpoint requires the `admin` role, a customer filtered orders by another `customerId`, or a non-admin requested another user's profile (`GET /api/v1/users/{userId}`). Orders and payments of other customers return [not_found](#not_found) instead, so their existence is not revealed.

## not_found

**404** — no route matches (`No route for GET /…`), the resource does not exist, or it exists but belongs to someone else (orders, payments). Also returned for draft products requested by non-admins, a user profile that has not been created yet right after registration (it is created asynchronously), unknown notification templates, inventory items, reservations and dead letters, and unknown services under `/docs/specs/`. The gateway answers 404 for every path that is not in its route table, including all internal and operational endpoints.

## conflict

**409** — generic conflict with the current state. Currently raised when creating an inventory record for a product that already has one (`POST /api/v1/inventory`); records are normally provisioned automatically from `ProductCreated`.

## unprocessable

**422** — generic semantic error. Currently raised when an order contains more distinct products than allowed (`MAX_ORDER_LINES`, default 20).

## payload_too_large

**413** — the request body exceeds the limit: 256 kB at the gateway, 100 kB at each service (`HTTP_BODY_LIMIT`).

## rate_limited

**429** — the gateway's per-IP limit was exceeded: 300 requests/min overall, 20 requests/min for login, register, refresh and password reset. `Retry-After` gives the seconds until the window resets; `RateLimit`/`RateLimit-Policy` describe the limit. Back off and retry after the indicated time. See [rate limits](README.md#rate-limits).

## internal_error

**500** — an unexpected error. `detail` is intentionally omitted; the error is logged with the `requestId`. Report the `requestId`. Retrying is safe only for idempotent requests (GET, or POSTs with an `Idempotency-Key`).

## service_unavailable

**503**, with `Retry-After: 5` — a dependency is temporarily unavailable:

- the gateway's circuit breaker for that upstream is open after repeated failures (`<name>-service is temporarily unavailable`);
- a service's circuit breaker towards another service is open (e.g. order-service → product-service during `POST /api/v1/orders`);
- the service cannot fetch the JWKS to verify tokens (`Token verification is temporarily unavailable`) — it fails closed.

Retry with back-off.

## upstream_error

**502** when a service-to-service call returned an error status, **504** when it did not answer in time (after the client's own retries for idempotent calls). Seen on `POST /api/v1/orders` when product-service cannot provide price snapshots. Retrying `POST /api/v1/orders` with the **same** `Idempotency-Key` is safe.

## invalid_path

**400** — the path contains encoded separators (`%2e`, `%2f`, `%5c`), a backslash, or `.`/`..` segments. The gateway rejects such paths before routing so they cannot reach unintended upstream endpoints.

## upstream_timeout

**504** — the upstream service did not respond within the gateway's timeout (10 s). The gateway never retries. For non-idempotent requests the operation may or may not have been applied: retry `POST /api/v1/orders` with the same `Idempotency-Key`; for other writes, read the current state before retrying.

## upstream_unreachable

**502** — the gateway could not connect to the upstream (container down, DNS, connection refused). Also returned by `/docs/specs/{service}.json` when a service's OpenAPI document cannot be fetched. Repeated failures open the circuit ([service_unavailable](#service_unavailable)).

## account_locked

**429**, with `Retry-After` — too many consecutive failed logins (5 by default) locked the account for 15 minutes. Attempts during the lock are rejected even with the correct password. Wait for `Retry-After` or reset the password.

## email_taken

**409** — `POST /api/v1/auth/register` with an email that already has an account (emails are compared case-insensitively). Log in or reset the password.

## invalid_reset_token

**400** — `POST /api/v1/auth/password-reset/confirm` with a token that is unknown, already used, superseded by a newer request, or older than 15 minutes. Request a new reset email.

## account_inactive

**409** — `PATCH /api/v1/users/me` on a suspended or closed account. (An access token can outlive a suspension by up to 15 minutes.)

## invalid_status_change

**422** — `PATCH /api/v1/users/{userId}/status` that is not allowed: administrators cannot change their own status, the account already has that status, or the account is closed (closure is final).

## duplicate_sku

**409** — `POST /api/v1/products` with a SKU that already exists.

## version_conflict

**409** — optimistic-concurrency failure: `expectedVersion` does not match the current `version` of a product (`PATCH /api/v1/products/{id}`) or a notification template (`PUT /api/v1/notifications/templates/{key}`), or another write happened concurrently. Reload the resource and reapply the change.

## invalid_status_transition

**422** — product status change not allowed. Allowed: `draft → active`, `draft → discontinued`, `active → discontinued`. `discontinued` is final.

## insufficient_stock

**422** — `POST /api/v1/inventory/{productId}/adjustments` would make on-hand stock lower than the quantity currently reserved for open orders. (Insufficient stock for an _order_ is not an HTTP error: the order is cancelled asynchronously with reason `out_of_stock`.)

## unknown_product

**422** — an order line references a product ID that does not exist.

## product_unavailable

**422** — an order line references a product that is not `active` (draft or discontinued).

## mixed_currency

**422** — the products in one order have different currencies; an order has exactly one currency.

## idempotency_key_reused

**422** — the `Idempotency-Key` was already used by the same caller with a **different** request body (orders: different lines or payment token; payments: different body for the same operation). Use a new key for a new request. See [Idempotency-Key](README.md#idempotency-key).

## invalid_order_state

**409** — `POST /api/v1/orders/{id}/cancel` is not allowed in the order's current status: the order is already `CANCELLED`, or a customer tried to cancel an order in `REQUIRES_REVIEW` (only admins can).

## idempotency_in_progress

**409** — another request with the same `Idempotency-Key` is still being processed. Retry after a short delay; you will then receive the stored result.

## idempotency_conflict

**409** — the idempotency record changed between the conflict and its lookup (for example, the first request failed and released the key). Retry the request.

## payment_exists

**409** — `POST /api/v1/payments/intents` for an order that already has a payment (one payment per order).

## invalid_payment_state

**409** — the operation is not valid for the payment's status: capture requires `AUTHORIZED` (capturing an already `CAPTURED` payment returns `200` unchanged), refund requires `CAPTURED`.

## invalid_refund_amount

**422** — the refund amount is not between 1 and the refundable amount (captured minus already refunded). Omit `amountCents` to refund the remaining amount.

## unknown_placeholder

**422** — a template edit (`PUT /api/v1/notifications/templates/{key}`) uses `{{placeholders}}` that the template does not support. Allowed placeholders are those of the default template plus `displayName`; `GET /api/v1/notifications/templates` lists them.

## invalid_dead_letter_state

**409** — replay or discard of a dead letter that is not `ARCHIVED` (already `REPLAYED` or `DISCARDED`).

## unknown_queue

**409** — replay of a dead letter whose original queue could not be determined. Inspect the record (`GET /admin/v1/dead-letters/{id}`) and handle it manually or discard it.
