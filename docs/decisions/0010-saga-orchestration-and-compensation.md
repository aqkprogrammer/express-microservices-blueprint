# ADR-0010: Saga orchestration and compensation

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Placing an order spans three services with separate databases: order-service (order), inventory-service (stock reservation) and payment-service (authorization and capture). There is no distributed transaction. The workflow must reach a safe outcome when any participant fails, is slow, or answers twice, and it must survive restarts. Payment providers add a particular difficulty: a timeout does not mean the payment failed.

## Decision

Use an **orchestrated saga** owned by order-service (`apps/order-service/src/domain/order-saga.ts`).

### Flow

| Step | Trigger                                      | Orchestrator action                                                                                                    |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /api/v1/orders`                        | Order `PENDING`, saga step `AWAITING_INVENTORY` with deadline, `OrderCreated` (one transaction, via outbox)            |
| 2    | `InventoryReserved`                          | Order `AWAITING_PAYMENT`, step `AWAITING_PAYMENT` with deadline, `PaymentAuthorizationRequested` (attempt 1)           |
| 3    | `PaymentAuthorized`                          | Order `CONFIRMED`, step `COMPLETED`, `OrderConfirmed` → inventory commits stock, payment captures, notification emails |
| ✗    | `InventoryReservationFailed`                 | Order `CANCELLED` (`out_of_stock`), step `COMPENSATED`, `OrderCancelled`                                               |
| ✗    | `PaymentFailed`                              | Order `CANCELLED` (`payment_failed`), `OrderCancelled` → inventory releases the reservation                            |
| ✗    | `InventoryReservationExpired`                | Order `CANCELLED` (`reservation_expired`) if still `PENDING`/`AWAITING_PAYMENT`                                        |
| ✗    | `InventoryCommitFailed` (after confirmation) | Order `REQUIRES_REVIEW`, `OrderRequiresReview`                                                                         |
| ✗    | Customer/admin cancel                        | Order `CANCELLED`, `OrderCancelled` → release stock, void (authorized) or refund (captured)                            |

### Persisted state and handler discipline

- Saga state lives in the `order_sagas` table (`step`, `deadline_at`, `payment_attempts`, `timeout_checks`, `started_at`), next to the order, so a restarted process resumes where it left off.
- Each handler, in one transaction: records the message ID (duplicates become no-ops), locks the order row (`SELECT … FOR UPDATE`), applies the transition only if the order state machine allows it (`apps/order-service/src/domain/order.ts`), and writes follow-up events to the outbox. Events that do not apply to the current state are counted (`saga_events_ignored_total`) and acknowledged.

### Timeouts and reconciliation

The worker publishes `order.check-saga-timeouts` every 10 s. For overdue sagas:

- **Inventory step** (default 60 s): cancel with `inventory_timeout`. Safe even if inventory reserves later — inventory releases on `OrderCancelled` or skips via its cancellation tombstone.
- **Payment step** (default 60 s; 15 s in Docker Compose): a timeout is **not** treated as a failure. The orchestrator calls `GET /internal/v1/payments/by-order/:orderId` on payment-service **outside** any transaction, then applies the decision under the row lock after re-checking the state:

| Payment status found                        | Decision                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTHORIZED`, `CAPTURED`                    | Confirm the order                                                                                                                                                                               |
| `FAILED`                                    | Cancel (`payment_failed`)                                                                                                                                                                       |
| `PENDING`/`PROCESSING`, or not found        | Re-request authorization (attempt + 1, new deadline). Payment-service deduplicates by order ID, so this cannot double-charge. After `SAGA_MAX_PAYMENT_ATTEMPTS` (default 3) → `REQUIRES_REVIEW` |
| `VOIDED`, `REFUNDED`                        | `REQUIRES_REVIEW` (inconsistent with an order awaiting payment)                                                                                                                                 |
| Lookup failed (payment-service unreachable) | Extend the deadline by 15 s and try again                                                                                                                                                       |

Payment-service runs its own reconciliation (`payment.reconcile`, every 15 s) for payments stuck in `PROCESSING` longer than `RECONCILE_AFTER_MS` (20 s), asking the provider for the real outcome.

### `REQUIRES_REVIEW`

When the saga cannot reach a safe terminal state automatically, the order is parked in `REQUIRES_REVIEW` and `OrderRequiresReview` is published (notification and audit consume it). A late `PaymentAuthorized` or `PaymentFailed` still moves the order to `CONFIRMED` or `CANCELLED`. Admins can cancel such an order (triggering compensation). There is **no** admin endpoint to force-confirm an order; see the [runbook](../operations/runbook.md#orders-requiring-review).

## Why orchestration over choreography here

- The order workflow has a clear owner and a small number of steps with timeouts; one place holding the state machine, deadlines and reconciliation logic is easier to reason about, test (`order.test.ts`) and observe (`saga_completed_total`, `saga_duration_seconds`, `saga_step_timeouts_total`).
- Timeouts need someone to notice the _absence_ of an event; in pure choreography no participant owns that responsibility.
- Participants stay simple: inventory and payment react to commands/events and know nothing about each other.

Choreography is still used where no workflow state is needed: profile creation from `UserRegistered`, notification emails, audit records, read-model updates.

## Consequences

### Positive

- Every order ends in `CONFIRMED`, `CANCELLED` or an explicit, alerting `REQUIRES_REVIEW` state — never silently stuck.
- Compensations are idempotent and order-independent (cancellation tombstones in inventory and payment handle a cancel that arrives before the create).

### Negative and trade-offs

- The orchestrator is a central dependency of the workflow; if order-service is down, sagas pause (but do not lose state).
- Eventual consistency is visible to clients: `POST /orders` returns `201` with status `PENDING`; clients poll `GET /orders/{id}`.
- Reconciliation depends on a synchronous internal call to payment-service.
- Manual review needs people and tooling; only cancellation is provided as an admin action.

## Alternatives considered

| Option                                              | Why not chosen                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choreography for the order flow                     | No owner for timeouts and reconciliation; the workflow is spread across services and harder to follow.                                                                    |
| Workflow engine (Temporal, Camunda, Step Functions) | Strong for long-running, complex workflows; an additional platform to run that would hide the mechanics this blueprint demonstrates. Worth considering as workflows grow. |
| Synchronous calls with distributed transactions     | Not available across PostgreSQL and RabbitMQ; would couple availability of all services.                                                                                  |

## Operational cost

- Scheduled timeout checks (worker) and reconciliation (payment-service) must run; their health is visible in `worker_jobs_total` and `job_runs`.
- On-call handling of `REQUIRES_REVIEW` orders (alert `OrdersAwaitingManualReview`).
- Timeout values must be tuned to real provider latencies.
