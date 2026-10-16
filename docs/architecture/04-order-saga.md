# 4. Order-processing saga

[← RabbitMQ event flow](03-rabbitmq-event-flow.md) · [Index](README.md) · Next: [Transactional outbox →](05-transactional-outbox.md)

order-service is the **orchestrator**
([`apps/order-service/src/domain/order-saga.ts`](../../apps/order-service/src/domain/order-saga.ts)).
It keeps the workflow state in `order_sagas` (step + deadline), reacts to participant events and
issues the next command or compensation through its outbox. Every handler records the message ID,
locks the order row, applies the transition only if the state machine allows it and writes
follow-up events in the same transaction — so duplicates and out-of-order events are harmless, and
a restarted process resumes where it left off.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant O as order-service
    participant MQ as RabbitMQ domain.events
    participant I as inventory-service
    participant P as payment-service
    participant N as notification-service

    C->>O: POST /api/v1/orders (Idempotency-Key)
    O->>O: tx: order PENDING + saga AWAITING_INVENTORY (deadline 60 s) + OrderCreated
    O-->>C: 201 Created, status PENDING
    O-)MQ: OrderCreated (order.created.v1)
    MQ-)I: OrderCreated
    alt stock available for every line
        I->>I: conditional UPDATE per line in product-id order, all or nothing → RESERVED (TTL 15 min)
        I-)MQ: InventoryReserved
        MQ-)O: InventoryReserved
        O->>O: AWAITING_PAYMENT · saga deadline = payment timeout
        O-)MQ: PaymentAuthorizationRequested (attempt 1)
        MQ-)P: PaymentAuthorizationRequested
        alt simulator approves
            P->>P: payment AUTHORIZED (unique order_id = idempotency anchor)
            P-)MQ: PaymentAuthorized
            MQ-)O: PaymentAuthorized
            O->>O: CONFIRMED · saga COMPLETED
            O-)MQ: OrderConfirmed
            par fan-out
                MQ-)I: OrderConfirmed → commit reservation → InventoryCommitted
            and
                MQ-)P: OrderConfirmed → capture → PaymentCaptured
            and
                MQ-)N: OrderConfirmed → order-confirmed email
            end
        else simulator declines
            P->>P: payment FAILED
            P-)MQ: PaymentFailed
            MQ-)O: PaymentFailed
            O->>O: CANCELLED (payment_failed) · saga COMPENSATED
            O-)MQ: OrderCancelled
            par compensation fan-out
                MQ-)I: OrderCancelled → release reservation → InventoryReleased
            and
                MQ-)P: OrderCancelled → FAILED needs nothing (AUTHORIZED → void, CAPTURED → refund)
            and
                MQ-)N: OrderCancelled → order-cancelled email
            end
        end
    else insufficient stock
        I-)MQ: InventoryReservationFailed
        MQ-)O: InventoryReservationFailed
        O->>O: CANCELLED (out_of_stock) · saga COMPENSATED
        O-)MQ: OrderCancelled
    end
```

<table>
<tr>
<td width="50%">

![Animated happy path of the order saga: OrderCreated, InventoryReserved, PaymentAuthorizationRequested, PaymentAuthorized, OrderConfirmed and the commit, capture and email fan-out](../assets/animated/order-saga-success.svg)

</td>
<td width="50%">

![Animated compensation path: the simulator declines the card, PaymentFailed cancels the order and OrderCancelled releases stock and notifies the customer](../assets/animated/order-saga-compensation.svg)

</td>
</tr>
</table>

_Animated previews (CSS animation) of the happy path and the payment-declined compensation path.
They pause into a static view when your system prefers reduced motion; the Mermaid diagrams on
this page are the static, accessible alternative._

## Order and saga states

```mermaid
stateDiagram-v2
    [*] --> PENDING: POST /orders
    PENDING --> AWAITING_PAYMENT: InventoryReserved
    PENDING --> CANCELLED: InventoryReservationFailed · inventory timeout · customer cancel
    AWAITING_PAYMENT --> CONFIRMED: PaymentAuthorized
    AWAITING_PAYMENT --> CANCELLED: PaymentFailed · reservation expired · customer cancel
    AWAITING_PAYMENT --> REQUIRES_REVIEW: payment outcome still unknown
    CONFIRMED --> CANCELLED: customer or admin cancel (refund)
    CONFIRMED --> REQUIRES_REVIEW: InventoryCommitFailed
    REQUIRES_REVIEW --> CONFIRMED: late PaymentAuthorized
    REQUIRES_REVIEW --> CANCELLED: late PaymentFailed or admin cancel
    CANCELLED --> [*]
```

Saga steps (`order_sagas.step`): `AWAITING_INVENTORY` → `AWAITING_PAYMENT` → `COMPLETED`, or
`COMPENSATED` (cancelled) / `REQUIRES_REVIEW`. Every `CANCELLED` transition emits `OrderCancelled`,
which drives the compensations; inventory and payment both keep **tombstones** when a cancel
arrives before the reservation or payment exists, so a late request is ignored instead of
re-reserving stock or charging the card.

## Timeouts and reconciliation

The worker publishes `maintenance.order.check-saga-timeouts` every 10 s. order-service then
handles overdue sagas — network calls happen outside any transaction and the decision is applied
under the row lock after re-checking the state.

```mermaid
flowchart TD
    tick["MaintenanceRequested<br/>order.check-saga-timeouts"] --> scan["find sagas past deadline_at<br/>step AWAITING_INVENTORY or AWAITING_PAYMENT"]
    scan --> which{"step?"}
    which -->|"AWAITING_INVENTORY<br/>60 s"| cancelInv["CANCELLED inventory_timeout<br/>OrderCancelled"]
    which -->|"AWAITING_PAYMENT<br/>15 s in compose, 60 s default"| lookup["GET payment-service<br/>/internal/v1/payments/by-order/:id"]
    lookup -->|"lookup fails"| extend["extend deadline by 15 s<br/>try again next tick"]
    lookup -->|"AUTHORIZED or CAPTURED"| confirm["CONFIRMED<br/>OrderConfirmed"]
    lookup -->|"FAILED"| cancelPay["CANCELLED payment_failed<br/>OrderCancelled"]
    lookup -->|"PENDING or NOT_FOUND"| attempts{"attempts below 3?"}
    attempts -->|"yes"| retry["re-publish PaymentAuthorizationRequested<br/>attempt + 1 · payment-service dedupes by order"]
    attempts -->|"no"| review["REQUIRES_REVIEW<br/>OrderRequiresReview"]
    lookup -->|"VOIDED or REFUNDED"| review
```

Other time-based guards: inventory expires `RESERVED` reservations after 15 minutes
(`maintenance.inventory.expire-reservations`, publishing `InventoryReservationExpired`, which
cancels the order with `reservation_expired`), and payment-service resolves payments stuck in
`PROCESSING` for more than 20 s by asking the simulator (`maintenance.payment.reconcile`).
