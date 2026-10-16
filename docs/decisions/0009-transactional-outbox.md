# ADR-0009: Transactional outbox

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

A service that commits a database change and then publishes an event can fail between the two steps: the order exists but `OrderCreated` is never sent (saga never starts), or the event is sent but the transaction rolls back (consumers act on something that does not exist). Two-phase commit across PostgreSQL and RabbitMQ is not available.

## Decision

Every service that publishes events uses a **transactional outbox**:

1. **Write** — `enqueueEvent(tx, type, payload, meta)` (`packages/database/src/outbox.ts`) validates the payload against the event contract, builds the envelope and inserts a row into the service's own `outbox_events` table **using the same transaction** as the business change. The current W3C trace context is stored in the row's `headers` column. An invalid payload fails the business transaction instead of poisoning consumers later.
2. **Relay** — `OutboxRelay` (`packages/messaging/src/outbox-relay.ts`) runs in-process in each service. It polls every **500 ms** and is woken immediately after a commit that wrote events (`relay.notify()`). A full batch (50 rows) triggers an immediate next cycle.
3. **Claim** — rows are leased with a single statement:
   `UPDATE outbox_events SET status='PUBLISHING', locked_until=now()+lease, attempts=attempts+1 WHERE id IN (SELECT id … WHERE (status='PENDING' AND available_at<=now()) OR (status='PUBLISHING' AND locked_until<now()) ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING …`
   The lease is **30 s**. `SKIP LOCKED` lets several replicas relay concurrently without blocking or double-claiming; a crashed relay's lease simply expires.
4. **Publish** — the row is published with a broker confirm (see [ADR-0005](0005-rabbitmq-default-broker.md)) inside a producer span whose parent is the stored trace context; then the row is marked `PUBLISHED`.
5. **Failure** — the row returns to `PENDING` with `last_error` and `available_at = now() + min(60 s, 500 ms × 2^attempts)`. Rows are **never dropped**.
6. **Retention** — the hourly `all.cleanup` maintenance task deletes `PUBLISHED` rows older than **72 h** (auth-service: **24 h**). Unpublished rows are never deleted.

Metrics: `outbox_pending_events`, `outbox_oldest_pending_age_seconds` (refreshed at most every 5 s), `outbox_events_relayed_total{outcome}`. The `OutboxPublishingStalled` alert fires when the oldest pending row is older than 120 s for 5 min ([runbook](../operations/runbook.md#outbox-stalled)).

## Consequences

### Positive

- An event is published **if and only if** its business change committed (eventually).
- Broker outages do not fail user requests; events queue up in PostgreSQL and drain when the broker returns.
- Retained published rows help debugging ("was this event really sent, and when?").

### Negative and trade-offs

- **At-least-once, not exactly-once**: a crash after the broker confirm but before `PUBLISHED` is written republishes the row after the lease expires. Consumers must be idempotent by envelope `id` ([ADR-0011](0011-idempotency.md)).
- **Ordering caveats**: rows are claimed in `created_at` order, but a failed row is retried later with back-off while newer rows proceed, and concurrent relays publish in parallel. Ordering is therefore **not guaranteed**, not even per aggregate. Consumers use state machines and guards (e.g. `occurredAt` comparison for stock read models) rather than relying on order.
- **Latency**: typically immediate thanks to `notify()`, but up to the poll interval when woken by the timer, and longer under back-off.
- **Polling load**: each service runs a small `UPDATE … SKIP LOCKED` query every 500 ms even when idle, plus a backlog `count(*)` at most every 5 s.
- Publishing from a single row lease means a very large backlog drains at batch size × cycle rate; there is no parallel fan-out within one relay.

## Alternatives considered

| Option                                         | Why not chosen                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Publish after commit, best effort              | Loses events on crashes; the saga would stall silently.                                                                                                |
| Change data capture (Debezium reading the WAL) | Lower latency and no polling, but adds Kafka Connect or a similar runtime and WAL configuration. A sensible upgrade at scale.                          |
| `LISTEN/NOTIFY` instead of polling             | Notifications are lost while no listener is connected; polling is still needed as a fallback. In-process `notify()` gives most of the latency benefit. |
| Separate relay process                         | Extra deployable; the in-process relay with `SKIP LOCKED` already scales with replicas.                                                                |

## Operational cost

- One extra table and two indexes per service; retention keeps it bounded.
- Monitoring of outbox age and pending count per service (alert included as an example).
- On a long broker outage, the outbox grows by the number of events produced; disk usage should be watched.
