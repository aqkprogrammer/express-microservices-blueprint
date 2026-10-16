# 6. Retry and dead-letter flow

[← Transactional outbox](05-transactional-outbox.md) · [Index](README.md) · Next: [Authentication →](07-authentication.md)

Consumers use manual acknowledgements and route every failure explicitly
([`packages/messaging/src/consumer.ts`](../../packages/messaging/src/consumer.ts)). A message is
acked only after its outcome has been durably handed off — to a retry queue, the dead-letter
exchange, or the handler's committed transaction — so failures are never silently swallowed.

```mermaid
flowchart TD
    deliver["message delivered from svc.events"] --> parse{"envelope + payload valid<br/>and event type handled?"}
    parse -->|"no: invalid_message or unhandled_event_type"| dlq
    parse -->|"yes"| handle["run handler<br/>processed_messages + business change in one tx"]
    handle -->|"success or duplicate"| ack["ack"]
    handle -->|"NonRetryableError"| dlq
    handle -->|"transient error"| tier{"retry attempt below<br/>number of tiers?"}
    tier -->|"yes"| retry["publish copy to svc.events.retry.N<br/>x-retry-attempt N, x-last-error · ack original"]
    retry -->|"TTL 1 s / 5 s / 15 s<br/>notification: 2 s / 10 s / 30 s"| back["dead-lettered back to svc.events<br/>via the default exchange"]
    back --> deliver
    tier -->|"no: retries_exhausted"| dlq["publish to dead-letters exchange<br/>x-dead-letter-reason · x-original-queue<br/>x-original-exchange · x-original-routing-key · x-last-error<br/>ack original"]
    retry -.->|"republish fails: broker trouble"| requeue["nack + requeue<br/>nothing is lost"]
    dlq -.->|"republish fails"| requeue
    requeue -.->|"crash loop: quorum x-delivery-limit 10"| native["RabbitMQ dead-letters natively<br/>x-first-death-* headers"]
    dlq --> archive
    native --> archive["worker.dead-letters  (binding #)<br/>worker upserts dead_letters row<br/>status ARCHIVED, occurrences + 1"]
    archive --> admin{"operator via worker admin API<br/>127.0.0.1:3009, admin token"}
    admin -->|"POST /admin/v1/dead-letters/:id/replay"| replay["republish original body to x-original-queue<br/>via the default exchange · status REPLAYED"]
    admin -->|"POST /admin/v1/dead-letters/:id/discard"| discard["status DISCARDED"]
    replay --> deliver
```

![Animated retry and dead-letter flow: a failing message passes retry.1, retry.2 and retry.3, is dead-lettered to the worker archive and replayed by an operator](../assets/animated/retry-dead-letter.svg)

_Animated preview (CSS animation). The Mermaid diagram above is the static, accessible
alternative._

## Notes

- **Retry tiers** are classic queues with a per-queue `x-message-ttl` and
  `x-dead-letter-exchange: ""` / `x-dead-letter-routing-key: <queue>`, so an expired message returns
  to its own main queue only — other consumers bound to the same event never see the retry.
- **Poison messages** (malformed envelope, schema mismatch, unknown event type) and
  `NonRetryableError` skip the tiers and are dead-lettered on the first delivery.
- **Delivery limit.** Main queues are quorum queues with `x-delivery-limit: 10` and
  `x-dead-letter-exchange: dead-letters`, the safety net for messages that crash the process before
  ack or nack.
- **The archive cannot lose messages.** `worker.dead-letters` uses an unlimited delivery limit and
  no DLX, consumes in raw mode (it must accept malformed messages) and requeues on failure.
- **Replay targets one consumer.** A replay goes to the original queue through the default
  exchange, not back through `domain.events`, so only the consumer that failed sees it again; it is
  idempotent by envelope ID.
- **Signals.** `messaging_retries_total`, `messaging_dead_lettered_total`,
  `dead_letters_archived_total` and `dead_letters_open` drive the `MessagesDeadLettered` and
  `RepeatedDeadLetters` alerts (runbook: `docs/operations/runbook.md#dead-letters`).
