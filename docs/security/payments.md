# Payments

> **payment-service is a local simulator.** It does not connect to any payment provider, does not move money, and never accepts card data. Everything under [Integrating a real provider](#integrating-a-real-provider) is a **recommendation that is not implemented** in this repository.

## What is implemented

| Aspect                    | Implementation                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider                  | `PaymentProviderSimulator` (`apps/payment-service/src/simulator/provider-simulator.ts`)                                                                                                                                                     |
| Payment method            | A simulated token, chosen per order (`paymentMethodToken`). The database enforces `CHECK (method_token ~ '^sim_[a-z_]+$')`, so a card number cannot be stored even by mistake. Tokens are never returned by the API.                        |
| One payment per order     | `UNIQUE (order_id)` — the idempotency anchor for saga commands ([ADR-0011](../decisions/0011-idempotency.md))                                                                                                                               |
| States                    | `PENDING → PROCESSING → AUTHORIZED → CAPTURED → REFUNDED`, plus `FAILED` and `VOIDED`; transitions are validated                                                                                                                            |
| Saga integration          | `PaymentAuthorizationRequested` → authorize; `OrderConfirmed` → capture; `OrderCancelled` → void (authorized), refund (captured), flag for void (in flight) or tombstone (no payment yet)                                                   |
| Unknown outcomes          | A provider timeout leaves the payment `PROCESSING`. Before re-authorizing, the service queries the provider's status. The `payment.reconcile` task (every 15 s) resolves payments `PROCESSING` for longer than `RECONCILE_AFTER_MS` (20 s). |
| Transient provider errors | Thrown, so the message goes through the retry queues                                                                                                                                                                                        |
| Back-office API (admin)   | `POST /api/v1/payments/intents` and `POST /api/v1/payments/{id}/refund` require `Idempotency-Key` with stored responses; `POST /api/v1/payments/{id}/capture`                                                                               |
| Audit                     | Every provider interaction is recorded in `payment_events`; payment events are consumed by audit-service                                                                                                                                    |

Simulator tokens:

| Token                    | Behaviour                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sim_card_approved`      | Approved (default)                                                                                                                                                  |
| `sim_card_declined`      | Declined → order cancelled (`payment_failed`)                                                                                                                       |
| `sim_insufficient_funds` | Declined with `insufficient_funds`                                                                                                                                  |
| `sim_provider_timeout`   | Authorization times out (outcome unknown); a status query reports it approved once `SIMULATOR_TIMEOUT_RESOLVES_AFTER_MS` (20 s) have passed since the first attempt |
| `sim_transient_error`    | Provider unavailable for the first two attempts, then approved (exercises message retries)                                                                          |

## Integrating a real provider

The steps below describe how a production integration should be built on top of this structure. **None of it is implemented.**

### 1. Replace the simulator

Implement a provider client with the same operations as `PaymentProviderSimulator` — `authorize`, `getAuthorizationStatus`, `capture`, `voidAuthorization`, `refund` — using the provider's SDK, and wire it in `apps/payment-service/src/main.ts`. Keep the existing structure:

- **Record intent → call provider → apply result.** Authorization already runs outside any database transaction and applies its result with a conditional status update. The simulator's capture, void and refund run inside the transaction only because they are instantaneous; a real client must use the same record-intent → call → apply structure for them, so a slow provider never holds a database connection or row lock.
- **Timeouts are not failures.** Keep `PROCESSING` and reconcile, as the saga already does ([ADR-0010](../decisions/0010-saga-orchestration-and-compensation.md)).
- Remove the `sim_` `CHECK` constraint only when replacing it with a check for the provider's token format.

### 2. Idempotency keys to the provider

Send a deterministic idempotency key with every mutating provider call, derived from local state so that retries reuse it — for example `payment.id` for authorization, and `<payment.id>:capture`, `<payment.id>:void`, `<payment.id>:refund:<refund-id>` for the follow-ups. Store the provider's object ID (`provider_reference` column) when it is returned. Never generate a fresh key on retry.

### 3. Webhooks

Providers report asynchronous outcomes (authorization results, captures, refunds, disputes) through webhooks. Recommended design:

- A dedicated public route, e.g. `POST /api/v1/payments/webhooks/<provider>`, added to the gateway route table **with a raw-body passthrough** (the gateway already forwards bodies byte-for-byte) and a body limit appropriate for the provider.
- **Verify the signature over the raw request body** before parsing JSON: compute the HMAC (typically HMAC-SHA256 with the endpoint secret) over the exact bytes — and the timestamp, if the provider's scheme includes it — and compare in constant time (`timingSafeEqual`). Re-serialising parsed JSON breaks signatures.
- **Reject stale timestamps** outside a small tolerance (e.g. 5 minutes) to limit replay, and support the provider's secret rotation (accept multiple active secrets during rotation).
- Treat webhook events as at-least-once and out of order: deduplicate by the provider's event ID (a `processed_messages`-style table), and apply state changes only if the payment's state machine allows them.
- Acknowledge quickly (2xx) after durably storing the event; process it asynchronously through the outbox.
- Do not trust webhook payload amounts or statuses blindly when they matter: fetch the object from the provider's API if the provider recommends it.

### 4. Reconciliation job

In addition to the existing `payment.reconcile` task for stuck authorizations, run a periodic job that compares the provider's settlement/transaction reports with `payments` and `payment_events`, flags mismatches (captured locally but not at the provider, refunds missing, unexpected disputes), and feeds them into the same manual-review process as `REQUIRES_REVIEW` orders.

### 5. Never store card data — reduce PCI DSS scope

- Never accept a primary account number (PAN), expiry or CVC in any API of this system, never log it, never put it in events.
- Collect card details with the provider's **hosted fields, hosted payment page or client SDK**, so card data goes from the browser/app directly to the provider and the backend only receives a token or payment-method ID. This typically keeps the backend in the reduced-scope self-assessment categories, but the actual scope depends on your integration and must be confirmed with your provider and a qualified assessor.
- Keep the method token out of responses and logs (already the case for the simulator token) and treat provider API keys and webhook secrets as secrets (`*_FILE`, secret manager, rotation).

### 6. Other production concerns

- Strong customer authentication / 3-D Secure flows (redirect or challenge) add an asynchronous step to the saga.
- Currency handling: amounts are integer minor units; validate currency exponents per provider.
- Dispute (chargeback) handling and refunds after capture need business processes beyond this blueprint.
