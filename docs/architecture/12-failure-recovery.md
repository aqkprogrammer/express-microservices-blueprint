# 12. Failure recovery

[← CI/CD pipeline](11-ci-cd.md) · [Index](README.md)

The system is designed so that every failure either heals automatically or ends in a durable,
visible state (an outbox row, a dead letter, an order in `REQUIRES_REVIEW`) — never in a silently
lost message. Operational procedures live in the runbook (`docs/operations/runbook.md`).

## Broker outage

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Service (HTTP)
    participant DB as Service DB (outbox_events)
    participant R as OutboxRelay + AMQP client
    participant MQ as RabbitMQ
    participant K as Consumers

    MQ--xR: connection lost
    Note over R: messaging_connection_up = 0 · readiness /health/ready → 503<br/>BrokerConnectionLost alert · unacked deliveries return to the queues
    C->>S: POST /api/v1/orders
    S->>DB: one tx: order + OrderCreated outbox row (PENDING)
    S-->>C: 201 — the write does not depend on the broker
    loop while disconnected
        R->>R: relay cycle skipped (client not connected), rows stay PENDING
        R->>MQ: amqplib reconnect with exponential backoff
    end
    MQ-->>R: connected
    Note over R: registered setup functions re-run:<br/>assert topology, re-subscribe every consumer
    R->>DB: claim backlog (FOR UPDATE SKIP LOCKED, 30 s lease)
    R->>MQ: publish with confirms
    R->>DB: mark PUBLISHED
    MQ-)K: deliver backlog + redeliver previously unacked messages
    Note over K: processed_messages makes duplicates no-ops
```

![Animated broker outage and recovery: events accumulate in the outbox while RabbitMQ is down, the AMQP client reconnects and the relay drains the backlog](../assets/animated/failure-recovery.svg)

_Animated preview (CSS animation). The Mermaid diagrams on this page are the static, accessible
alternative._

In Docker Compose the gateway keeps routing to a service whose readiness is 503, so writes keep
landing in the outbox. In Kubernetes the same 503 removes the pod from its Service endpoints until
the broker is back, which turns a broker outage into fast `503`s at the edge instead of stuck
requests.

## Database outage

```mermaid
flowchart TD
    down["PostgreSQL unreachable"] --> ready["/health/ready → 503<br/>postgres is a critical check"]
    down --> http["HTTP handlers return<br/>problem+json 5xx · no partial writes"]
    down --> consume["consumer handler throws<br/>→ retry.1 / retry.2 / retry.3 → dead-letters"]
    down --> relay["outbox relay cycle fails<br/>retried after at least 2 s"]
    ready --> orch["Compose health check / Kubernetes readiness<br/>mark the container unhealthy"]
    up["PostgreSQL back"] --> pool["pg pool opens new connections"]
    pool --> resume["requests succeed · relay drains outbox"]
    consume -.->|"if retries were exhausted"| replay["replay from the worker dead-letter archive<br/>handlers are idempotent"]
```

## Payment timeout and reconciliation

A timeout is never treated as a failure; the orchestrator asks payment-service for the real
outcome first.

```mermaid
sequenceDiagram
    autonumber
    participant W as worker scheduler
    participant O as order-service
    participant P as payment-service
    participant SIM as payment simulator

    P->>SIM: authorize (sim_provider_timeout)
    SIM--xP: no answer
    Note over P: payment stays PROCESSING (outcome unknown)
    W-)O: maintenance.order.check-saga-timeouts (every 10 s)
    O->>P: GET /internal/v1/payments/by-order/:id
    alt AUTHORIZED or CAPTURED
        O->>O: CONFIRMED + OrderConfirmed
    else FAILED
        O->>O: CANCELLED payment_failed + OrderCancelled
    else PENDING, PROCESSING or NOT_FOUND and attempts below 3
        O->>O: re-publish PaymentAuthorizationRequested (attempt + 1)
        Note over P: same order ID → same payment row, no double charge<br/>PROCESSING: ask the provider for the status before authorizing again
    else still unknown after 3 attempts, or VOIDED / REFUNDED
        O->>O: REQUIRES_REVIEW + OrderRequiresReview (OrdersAwaitingManualReview alert)
    else lookup failed
        O->>O: extend the deadline by 15 s and retry
    end
    W-)P: maintenance.payment.reconcile (every 15 s)
    P->>SIM: status of payments PROCESSING for more than 20 s
    SIM-->>P: AUTHORIZED or FAILED → PaymentAuthorized / PaymentFailed
```

## Process crash

```mermaid
flowchart LR
    crash["service process crashes<br/>or is killed mid-work"] --> a["open DB transaction<br/>rolled back by PostgreSQL"]
    crash --> b["claimed outbox rows stay PUBLISHING<br/>lease expires after 30 s → claimed again"]
    crash --> c["unacked RabbitMQ deliveries<br/>requeued by the broker → redelivered"]
    crash --> d["saga state is in order_sagas<br/>deadlines picked up by the next timeout check"]
    b --> idem["duplicates possible:<br/>consumers dedupe via processed_messages"]
    c --> idem
    c --> limit["crash loop on one message:<br/>quorum x-delivery-limit 10 → dead-letters"]
    restart["restart: unless-stopped / Kubernetes restart"] --> recover["on boot: reconnect, re-assert topology,<br/>resume consumers and the relay"]
    crash --> restart
```

Graceful shutdown (SIGTERM; 15 s internal deadline inside the 20 s Compose grace period) first
reports not-ready, stops accepting HTTP connections, then runs the shutdown hooks in reverse order
— consumers drain in-flight handlers, the relay stops, connections close. Anything still unacked
after the consumer drain timeout is redelivered by the broker.
