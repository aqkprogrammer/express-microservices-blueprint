# Event catalog

The source of truth is code: event definitions and payload schemas in [`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts), queues and bindings in [`packages/contracts/src/topology.ts`](../../packages/contracts/src/topology.ts). This page summarises them; if they disagree, the code wins (and this page should be fixed).

## Conventions

- **Exchange:** all domain events are published to the durable topic exchange `domain.events`.
- **Routing key:** `<domain>.<event>.v<version>` (e.g. `order.created.v1`). The domain prefix is the producing service's domain (`auth`, `user`, `product`, `inventory`, `order`, `payment`, `notification`).
- **Envelope** (validated by every consumer):

  | Field             | Meaning                                                        |
  | ----------------- | -------------------------------------------------------------- |
  | `id`              | UUID; the consumer idempotency key                             |
  | `type`, `version` | e.g. `OrderCreated`, `1`                                       |
  | `occurredAt`      | ISO 8601 timestamp with offset                                 |
  | `producer`        | Producing service                                              |
  | `correlationId`   | Business transaction (the order ID for the order saga)         |
  | `causationId`     | ID of the request or message that caused this event (optional) |
  | `subject`         | Aggregate ID (optional)                                        |
  | `payload`         | Event-specific, validated against the contract schema          |

- **AMQP properties:** persistent, `messageId` = envelope `id`, `type` = `<Type>.v<version>`, `appId` = producer, `correlationId`, W3C `traceparent`/`tracestate` and `x-correlation-id` headers.
- **Delivery:** at least once, no ordering guarantee. Consumers must be idempotent ([ADR-0011](../decisions/0011-idempotency.md)).
- Money is always integer minor units (`…Cents`) with an ISO 4217 `currency`.

## Domain events (v1)

Consumers are the services whose queue binds the routing key (audit-service binds `auth.#`, `user.#`, `product.#` and `payment.#` as wildcards).

### auth-service

| Event                       | Routing key                            | Consumers                                         | Purpose                                                        |
| --------------------------- | -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `UserRegistered`            | `auth.user-registered.v1`              | user-service, notification-service, audit-service | New account: create profile and email recipient; welcome email |
| `UserLoggedIn`              | `auth.user-logged-in.v1`               | audit-service                                     | Security audit: session opened                                 |
| `UserLoggedOut`             | `auth.user-logged-out.v1`              | audit-service                                     | Security audit: session revoked by its owner                   |
| `LoginFailed`               | `auth.login-failed.v1`                 | audit-service                                     | Security audit; never contains the submitted email or password |
| `RefreshTokenReuseDetected` | `auth.refresh-token-reuse-detected.v1` | audit-service                                     | A rotated refresh token was replayed; session family revoked   |
| `PasswordResetRequested`    | `auth.password-reset-requested.v1`     | audit-service                                     | Reset token issued (token not included)                        |
| `PasswordChanged`           | `auth.password-changed.v1`             | audit-service                                     | Password changed via reset; all sessions revoked               |

### user-service

| Event                | Routing key               | Consumers                           | Purpose                                                                             |
| -------------------- | ------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `UserProfileUpdated` | `user.profile-updated.v1` | notification-service, audit-service | Refresh the recipient copy (email, display name)                                    |
| `UserStatusChanged`  | `user.status-changed.v1`  | auth-service, audit-service         | `active`/`suspended`/`closed`: auth blocks login and revokes sessions when inactive |

### product-service

| Event            | Routing key          | Consumers                        | Purpose                                         |
| ---------------- | -------------------- | -------------------------------- | ----------------------------------------------- |
| `ProductCreated` | `product.created.v1` | inventory-service, audit-service | Inventory provisions a stock record (on hand 0) |
| `ProductUpdated` | `product.updated.v1` | audit-service                    | Name, price or status changed (`changedFields`) |

### inventory-service

| Event                         | Routing key                        | Consumers                    | Purpose                                                                                           |
| ----------------------------- | ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `InventoryReserved`           | `inventory.reserved.v1`            | order-service                | Saga: all lines reserved until `expiresAt`                                                        |
| `InventoryReservationFailed`  | `inventory.reservation-failed.v1`  | order-service                | Saga: nothing reserved (`insufficient_stock` / `unknown_product`)                                 |
| `InventoryReleased`           | `inventory.released.v1`            | — (none bound)               | Compensation done: stock returned (`order_cancelled` / `expired`)                                 |
| `InventoryReservationExpired` | `inventory.reservation-expired.v1` | order-service                | Reservation TTL passed before confirmation                                                        |
| `InventoryCommitted`          | `inventory.committed.v1`           | — (none bound)               | Reserved stock deducted after confirmation                                                        |
| `InventoryCommitFailed`       | `inventory.commit-failed.v1`       | order-service, audit-service | Confirmed order cannot be fulfilled from stock → order requires review                            |
| `InventoryStockChanged`       | `inventory.stock-changed.v1`       | product-service              | Availability read model (`onHand`, `reserved`, `available`); stale events ignored by `occurredAt` |

### order-service

| Event                           | Routing key                                | Consumers                                                               | Purpose                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrderCreated`                  | `order.created.v1`                         | inventory-service                                                       | Saga start: reserve stock for the priced lines                                                                                                                                                  |
| `PaymentAuthorizationRequested` | `order.payment-authorization-requested.v1` | payment-service                                                         | Saga command: authorize `amountCents` (`attempt` ≥ 1; re-sent after timeouts)                                                                                                                   |
| `OrderConfirmed`                | `order.confirmed.v1`                       | inventory-service, payment-service, notification-service, audit-service | Saga success: commit stock, capture payment, confirmation email                                                                                                                                 |
| `OrderCancelled`                | `order.cancelled.v1`                       | inventory-service, payment-service, notification-service, audit-service | Compensation: release/restock, void/refund, cancellation email. `reason`: `out_of_stock`, `payment_failed`, `reservation_expired`, `inventory_timeout`, `customer_requested`, `admin_requested` |
| `OrderRequiresReview`           | `order.requires-review.v1`                 | notification-service, audit-service                                     | Saga could not reach a safe state automatically                                                                                                                                                 |

### payment-service

| Event               | Routing key             | Consumers                           | Purpose                                                                          |
| ------------------- | ----------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `PaymentAuthorized` | `payment.authorized.v1` | order-service, audit-service        | Saga: amount held (simulator)                                                    |
| `PaymentFailed`     | `payment.failed.v1`     | order-service, audit-service        | Saga: definitively declined (`declined`, `insufficient_funds`, `provider_error`) |
| `PaymentCaptured`   | `payment.captured.v1`   | audit-service                       | Funds captured after confirmation                                                |
| `PaymentVoided`     | `payment.voided.v1`     | audit-service                       | Compensation: authorization released                                             |
| `PaymentRefunded`   | `payment.refunded.v1`   | notification-service, audit-service | Compensation or back-office refund; refund email                                 |

### notification-service

| Event                        | Routing key                       | Producer                                                 | Consumers            | Purpose                                                                                  |
| ---------------------------- | --------------------------------- | -------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- |
| `NotificationRequested`      | `notification.requested.v1`       | any service (currently auth-service, for password reset) | notification-service | Send a named template to a user; keys in `sensitiveDataKeys` are scrubbed after delivery |
| `NotificationSent`           | `notification.sent.v1`            | notification-service                                     | — (none bound)       | Email handed to the transport                                                            |
| `NotificationDeliveryFailed` | `notification.delivery-failed.v1` | notification-service                                     | audit-service        | Delivery failed permanently after retries                                                |

Events with no bound queue are dropped by the exchange; a consumer added later only receives new events (RabbitMQ has no replay — see [ADR-0006](../decisions/0006-when-kafka-is-appropriate.md)).

## Maintenance commands

The worker publishes `MaintenanceRequested.v1` (payload `{ task, scheduledAt }`) to the topic exchange `maintenance.commands`, guarded by a Redis leader lock (fail-open). Commands are idempotent.

| Task                            | Routing key                                 | Interval | Executed by                                                                                                   |
| ------------------------------- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `inventory.expire-reservations` | `maintenance.inventory.expire-reservations` | 15 s     | inventory-service                                                                                             |
| `order.check-saga-timeouts`     | `maintenance.order.check-saga-timeouts`     | 10 s     | order-service                                                                                                 |
| `payment.reconcile`             | `maintenance.payment.reconcile`             | 15 s     | payment-service                                                                                               |
| `audit.apply-retention`         | `maintenance.audit.apply-retention`         | 1 h      | audit-service                                                                                                 |
| `all.cleanup`                   | `maintenance.all.cleanup`                   | 1 h      | auth, user, product, inventory, order, payment, notification and audit services (outbox and marker retention) |

## Queues

| Queue                                                                                                                                                                        | Owner                | Retry delays    | Notes                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------- | ----------------------------------------------------------------------------- |
| `auth-service.events`, `user-service.events`, `product-service.events`, `inventory-service.events`, `order-service.events`, `payment-service.events`, `audit-service.events` | the named service    | 1 s, 5 s, 15 s  | Quorum, `x-delivery-limit` 10, DLX `dead-letters`                             |
| `notification-service.events`                                                                                                                                                | notification-service | 2 s, 10 s, 30 s | Email providers recover slowly                                                |
| `<queue>.retry.1..N`                                                                                                                                                         | —                    | TTL per tier    | Classic queues; expire back into the main queue                               |
| `worker.dead-letters`                                                                                                                                                        | worker               | 1 s, 5 s        | Bound `#` on `dead-letters`; unlimited delivery; requeues instead of dropping |

## Versioning policy

- **Additive changes stay in v1.** Adding an optional field (or a field with a default) to a payload is allowed; consumers must ignore fields they do not know. The frozen fixtures in `tests/contract/fixtures/events.v1.json` must keep parsing.
- **Breaking changes create v2.** Removing, renaming or retyping a field, changing its meaning, or making an optional field required requires a new version (e.g. `OrderCreated.v2`, routing key `order.created.v2`) defined alongside v1.
- **Publish both in parallel** during migration: the producer emits v1 and v2 (two outbox rows in the same transaction); consumers move to v2 one by one; v1 is removed only when no queue binds it any more.
- Enum widening (a new `reason` value) is a breaking change for consumers that switch exhaustively; treat it as one unless every consumer handles unknown values.
- Update this page and the contract fixtures in the same change.
