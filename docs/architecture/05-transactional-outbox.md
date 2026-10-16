# 5. Transactional outbox

[← Order saga](04-order-saga.md) · [Index](README.md) · Next: [Retry and dead-letter flow →](06-retry-dead-letter.md)

No service publishes to RabbitMQ from a request handler. Events are inserted into the service's
own `outbox_events` table **in the same transaction** as the state change
([`packages/database/src/outbox.ts`](../../packages/database/src/outbox.ts)) and published later by
the `OutboxRelay` running in the same process
([`packages/messaging/src/outbox-relay.ts`](../../packages/messaging/src/outbox-relay.ts)). The
state change and the event therefore commit together or not at all, and a broker outage never
fails a request (see [page 12](12-failure-recovery.md)).

```mermaid
sequenceDiagram
    autonumber
    participant H as Handler (HTTP or consumer)
    participant DB as Service database
    participant R as OutboxRelay
    participant MQ as RabbitMQ
    participant C as Consumer service

    H->>DB: BEGIN
    H->>DB: business change (e.g. INSERT order)
    H->>DB: enqueueEvent(tx): validate payload against the contract,<br/>INSERT outbox_events status PENDING + envelope + traceparent headers
    H->>DB: COMMIT
    H->>R: notify() after commit
    Note over R: otherwise polls every 500 ms
    R->>DB: UPDATE ... SET status PUBLISHING, locked_until now + 30 s, attempts + 1<br/>WHERE id IN (SELECT ... ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
    loop each claimed row
        R->>MQ: publish persistent message on confirm channel (producer span, traceparent)
        alt broker confirms within 5 s
            MQ-->>R: ack
            R->>DB: status PUBLISHED, published_at now
        else nack, timeout or disconnected
            R->>DB: status PENDING, available_at now + backoff (500 ms × 2^attempts, max 60 s)
        end
    end
    MQ-)C: deliver to the consumer queue
    C->>C: same tx as the handler: INSERT processed_messages (consumer, message_id)<br/>duplicate → skip, then ack
```

![Animated transactional outbox: a handler commits a business change together with an outbox row, the relay claims it with SKIP LOCKED, publishes with confirms and marks it published, and the consumer de-duplicates](../assets/animated/transactional-outbox.svg)

_Animated preview (CSS animation). The Mermaid diagrams on this page are the static, accessible
alternative._

## Outbox row lifecycle

```mermaid
stateDiagram-v2
    [*] --> PENDING: INSERT in the business transaction
    PENDING --> PUBLISHING: claimed (FOR UPDATE SKIP LOCKED, lease 30 s)
    PUBLISHING --> PUBLISHED: broker confirm
    PUBLISHING --> PENDING: publish failed, exponential backoff
    note right of PUBLISHING
        If the relay crashes, the lease expires
        and any relay instance claims the row again.
    end note
    PUBLISHED --> [*]: deleted by maintenance.all.cleanup after 72 h (auth 24 h)
```

## Guarantees and trade-offs

- **At-least-once publication.** A crash between the broker confirm and `PUBLISHED` re-publishes
  the row after the lease expires. Consumers are idempotent by envelope ID (`processed_messages`
  inserted inside the handler's transaction), so the duplicate is a no-op.
- **Never dropped.** Failed publishes go back to `PENDING` with backoff; there is no maximum
  attempt count. `outbox_pending_events` and `outbox_oldest_pending_age_seconds` feed the
  `OutboxPublishingStalled` alert.
- **Safe with replicas.** `FOR UPDATE SKIP LOCKED` lets several relay instances run concurrently
  without blocking or double-claiming.
- **Ordering.** Rows are claimed in `created_at` order, but retries can reorder events; handlers
  rely on the state machine and `occurredAt` guards rather than delivery order.
- **Traceable.** The trace context captured at write time is stored with the row, so the relay's
  producer span and the consumer span join the originating request's trace
  ([page 8](08-observability.md)).
