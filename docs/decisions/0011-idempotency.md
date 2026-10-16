# ADR-0011: Idempotency for messages and REST commands

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Every delivery path in the system can produce duplicates: the outbox relay is at-least-once ([ADR-0009](0009-transactional-outbox.md)), RabbitMQ redelivers unacknowledged messages, retries re-run handlers, operators replay dead letters, the saga re-requests payment authorization after timeouts, and HTTP clients retry requests whose responses they did not receive. Messages can also arrive out of order (a cancel before the create). Duplicates must never double-reserve stock, double-charge, or send two emails.

## Decision

Use several complementary mechanisms, each placed where it is cheapest and safest.

### 1. Processed-message markers in the handler transaction

`markMessageProcessed(tx, consumer, messageId)` (`packages/database/src/processed-messages.ts`) inserts `(consumer, message_id)` into `processed_messages` with `ON CONFLICT DO NOTHING` **inside the same transaction** as the handler's side effects. If the insert affects no row, the message was already handled and the handler returns. If the transaction rolls back, the marker disappears with it, so a retry processes the message again. The consumer name is per handler (e.g. `inventory.order-created`), so one message can be processed by several handlers in the same service. Markers are deleted after 7 days.

### 2. Business-state anchoring where a marker is not enough

- **Payment**: one payment per order (`UNIQUE (order_id)`) is the idempotency anchor. `PaymentAuthorizationRequested` is deliberately handled without a marker: re-requests from the saga must _replay_ the existing outcome (`PaymentAuthorized`/`PaymentFailed` for a finished payment) or resume an in-flight one, never create a second payment. The provider is called with the payment ID, which a real provider would receive as its idempotency key.
- **Inventory**: one reservation per order (`UNIQUE (order_id)`); a second `OrderCreated` for an order that already has any reservation record is skipped.
- **Notifications**: one notification per `(source_event_id, template)`; a row already `SENT` is never sent again.
- **Order saga**: transitions are guarded by the order state machine, so a duplicate or stale event "does not apply" rather than causing harm.

### 3. Tombstones for out-of-order compensation

If `OrderCancelled` arrives before the work it compensates:

- inventory-service stores a reservation with status `CANCELLED`; a later `OrderCreated` sees an existing record and does not reserve.
- payment-service stores a `VOIDED` payment with `cancel_requested = true`; a later `PaymentAuthorizationRequested` is ignored. A cancel that arrives while authorization is in flight sets `cancel_requested`, and an approval that lands afterwards is voided immediately.

### 4. `Idempotency-Key` for REST commands

| Endpoint                                    | Scope                                  | Storage                                                                                                      | Replay                                         | Same key, different body     | Concurrent duplicate                                   |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| `POST /api/v1/orders`                       | `(customer, key)`, unique on `orders`  | The order itself, with a SHA-256 fingerprint of the canonical request (merged, sorted lines + payment token) | `200`, same order, `Idempotent-Replayed: true` | `422 idempotency_key_reused` | Unique violation; the loser returns the winner's order |
| `POST /api/v1/payments/intents` (admin)     | `(admin user, "intents", key)`         | `idempotency_records` table with stored status and body                                                      | Stored response, `Idempotent-Replayed: true`   | `422 idempotency_key_reused` | `409 idempotency_in_progress`                          |
| `POST /api/v1/payments/{id}/refund` (admin) | `(admin user, "refund", payment, key)` | `idempotency_records`                                                                                        | Stored response                                | `422 idempotency_key_reused` | `409 idempotency_in_progress`                          |

Keys must match `^[A-Za-z0-9_-]{8,128}$` (UUIDs recommended). A failed payment operation deletes its record so the client can retry. Payment idempotency records are deleted after **24 h**; reusing a key after that executes the operation again (intents are still protected by the one-payment-per-order constraint; refunds are not). Order idempotency keys live as long as the order.

## Consequences

### Positive

- Every consumer can safely receive any message more than once and in any order relevant to it; operators can replay dead letters without fear.
- Clients can retry order creation after network errors without creating duplicate orders.

### Negative and trade-offs

- Extra writes per handled message (`processed_messages`) and a table to prune.
- Marker retention (7 days) bounds protection: a duplicate delivered later than that would be processed again. Broker redelivery windows are far shorter, but replaying a very old dead letter relies on the business-state guards above.
- Business-state anchoring is designed per use case; there is no generic mechanism that covers every new handler. New handlers must choose a strategy deliberately (see [adding a service](../development/adding-a-service.md)).
- Payment idempotency records store response bodies, which contain payment data; they are short-lived for that reason.

## Alternatives considered

| Option                                       | Why not chosen                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Rely on broker "exactly-once"                | Not available end-to-end across database and broker.                                                                                        |
| Deduplication in Redis                       | Would make correctness depend on a cache ([ADR-0007](0007-redis-not-system-of-record.md)) and could not be atomic with the database change. |
| Markers written after the transaction        | A crash between commit and marker write re-runs side effects.                                                                               |
| Generic idempotency middleware for all POSTs | Different endpoints have different natural anchors; orders use the order row itself, which avoids a second store.                           |

## Operational cost

- Retention jobs (hourly `all.cleanup`) keep the tables bounded; see [data retention](../operations/data-retention.md).
- Reviews of new handlers must check the idempotency strategy.
