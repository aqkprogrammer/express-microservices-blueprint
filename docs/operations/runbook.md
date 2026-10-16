# Runbook

Each section below is referenced by an alert in `infrastructure/prometheus/alerts.yml` (annotation `runbook: docs/operations/runbook.md#<anchor>`). Commands assume the local Docker Compose stack (project name `emb`) started from the repository root. In other environments, substitute the equivalent tooling (`kubectl logs`, managed-database consoles, …).

> The alert rules and thresholds are **examples** for a local demo. Tune them against real traffic and SLOs before relying on them; see [observability](observability.md).

## Tools and access

| Tool                | Local URL                                                                                                                              | Credentials (local defaults)           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Grafana             | <http://localhost:3000> — dashboards _Services overview (RED)_ (`/d/emb-services`) and _Messaging, outbox & saga_ (`/d/emb-messaging`) | `admin` / `local-dev-grafana-password` |
| Prometheus          | <http://localhost:9090> (alerts at `/alerts`)                                                                                          | none                                   |
| Jaeger              | <http://localhost:16686>                                                                                                               | none                                   |
| RabbitMQ management | <http://localhost:15672>                                                                                                               | `emb` / `local-dev-rabbitmq-password`  |
| Mailpit             | <http://localhost:8025>                                                                                                                | none                                   |
| Worker admin API    | <http://127.0.0.1:3009/admin/v1>                                                                                                       | admin bearer token                     |

The local stack has no Alertmanager; firing alerts are visible in the Prometheus UI only.

Most procedures need an admin access token (valid 15 minutes). Login is rate-limited to 20 requests per minute per IP.

```sh
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.test","password":"local-dev-admin-password"}' | jq -r .accessToken)
```

Useful one-liners:

```sh
docker compose ps                                     # state and health of every container
docker compose logs --since 15m --no-log-prefix order-service \
  | jq -R 'fromjson? | select(.level=="error" or .level=="warn")'   # recent warnings/errors
docker compose exec postgres psql -U postgres -d orders_db          # SQL shell on one service DB
docker compose exec rabbitmq rabbitmq-diagnostics status            # broker health
```

Service databases: `auth_db`, `users_db`, `product_db`, `inventory_db`, `orders_db`, `payment_db`, `notification_db`, `audit_db`, `worker_db`.

## Service down

**Alert:** `ServiceDown` — `up{job="services"} == 0` for 1 minute (Prometheus cannot scrape `/metrics`).

**Symptoms:** requests through the gateway for that service return `503 service_unavailable` (circuit open), `502 upstream_unreachable` or `504 upstream_timeout`; `docker compose ps` shows the container as `restarting`, `exited` or `unhealthy`; events for its queue accumulate.

**Likely causes:**

- Start-up failure: invalid configuration (the log line names the variable, never its value), unreadable secret file (`*_FILE`), migrator failed so the service never started.
- Readiness failing: PostgreSQL or RabbitMQ unreachable (both are critical readiness checks; Redis is not).
- Out of memory: Compose limits most services to 256 MB (auth-service 384 MB).
- Process alive but `/metrics` hanging (event-loop blocked).

**Diagnosis:**

```sh
docker compose ps -a order-service
docker compose logs --tail=200 order-service
docker inspect --format 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' emb-order-service-1
# Readiness report (service ports are not published; ask from inside the container)
docker compose exec order-service node -e \
  "fetch('http://127.0.0.1:3005/health/ready').then(r=>r.text()).then(console.log)"
docker compose logs migrator | tail -50
```

In Grafana, _Services overview_ → _Process memory (RSS)_ shows memory growth before an OOM kill.

**Remediation:**

1. Configuration error → fix the variable in `.env` / Compose and `docker compose up -d <service>`.
2. Dependency down → follow [broker unavailable](#broker-unavailable) or check PostgreSQL (`docker compose logs postgres`).
3. OOM → raise the memory limit for that service, then investigate the growth (heap snapshot, recent changes).
4. Migrator failed → see [troubleshooting](../troubleshooting/README.md#migrator-failed), then `docker compose up -d`.
5. After recovery, check [queue backlog](#queue-backlog) and [outbox stalled](#outbox-stalled): queued work drains automatically.

## Elevated error rate

**Alert:** `HighHttpErrorRate` — more than 5 % of a service's HTTP responses are 5xx for 5 minutes.

**Symptoms:** clients receive `500 internal_error`, `502`/`504 upstream_*` or `503 service_unavailable` problem documents; the _5xx error ratio_ panel rises.

**Likely causes:** a dependency failing (database, product-service for order creation, JWKS for token verification), an open circuit breaker, a bug in a recent deployment, statement timeouts (10 s) on slow queries.

**Diagnosis:**

```promql
# Which routes and status codes
sum by (service, route, status_code) (rate(http_requests_total{status_code=~"5.."}[5m]))
# Gateway view of upstreams (kind = timeout | connection | circuit_open | stream)
sum by (upstream, kind) (rate(gateway_upstream_errors_total[5m]))
gateway_upstream_circuit_open == 1
# Service-to-service calls (order-service → product-service / payment-service)
sum by (service, target, outcome) (rate(http_client_requests_total[5m]))
http_client_circuit_open == 1
```

```sh
docker compose logs --since 15m --no-log-prefix order-service \
  | jq -R 'fromjson? | select(.level=="error") | {time, message, requestId, traceId, err}'
```

Open a failing request's trace in Jaeger: `http://localhost:16686/trace/<traceId>` (see [finding a trace from a request ID](observability.md#find-a-trace-from-a-request-id)).

**Remediation:**

- Dependency failure → restore the dependency; circuits close automatically after 10 s and one successful trial request.
- Bad deployment → roll back to the previous image.
- `503 Token verification is temporarily unavailable` → auth-service JWKS unreachable from the service; restore auth-service. Services fail closed by design.
- Errors are 4xx, not 5xx → not this alert; check client behaviour and the [error catalogue](../api/errors.md).

## Latency

**Alert:** `HighHttpLatencyP95` — p95 HTTP latency above 1 s for 10 minutes (health and metrics routes excluded).

**Symptoms:** slow responses; _p95 latency by service/route_ panels high; possibly `504 upstream_timeout` at the gateway (10 s).

**Likely causes:** slow queries or lock contention, database pool waits ([database pool exhaustion](#database-pool-exhaustion)), slow synchronous dependency (order creation calls product-service, 2 s timeout with up to 2 retries), CPU throttling (Compose CPU limit 0.5 per service), Argon2id hashing under login load (CPU- and memory-intensive by design).

**Diagnosis:**

```promql
histogram_quantile(0.95, sum by (service, route, le) (rate(http_request_duration_seconds_bucket[5m])))
histogram_quantile(0.95, sum by (target, le) (rate(http_client_request_duration_seconds_bucket[5m])))
max by (service, pool, state) (db_pool_connections)
```

- In Jaeger, search the service with _Min Duration_ (e.g. `1s`) and look at which span dominates (`pg` query, outgoing `fetch`, …).
- Check container CPU: `docker stats --no-stream`.
- Long-running queries:

```sh
docker compose exec postgres psql -U postgres -c \
  "SELECT datname, pid, now()-query_start AS age, state, left(query,120) FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC LIMIT 20;"
```

**Remediation:** fix or index the slow query, raise CPU limits, scale the service horizontally, or tune the dependency timeout. Do not raise the gateway timeout to hide slowness.

## Queue backlog

**Alert:** `RabbitMQQueueBacklog` — more than 1000 ready messages in a queue for 10 minutes.

**Symptoms:** delayed side effects (orders stay `PENDING`, emails late, read models stale); _Queue depth (ready)_ rising.

**Likely causes:** consumer down or not connected; handlers slow (database, SMTP); a burst of events; a message repeatedly failing and cycling through retry queues.

**Diagnosis:**

```sh
docker compose exec rabbitmq rabbitmqctl list_queues name type messages_ready messages_unacknowledged consumers
```

- RabbitMQ UI → _Queues_: consumers count, ack rate vs publish rate, retry queues (`<queue>.retry.N`) with many messages.
- Prometheus:

```promql
sum by (queue, outcome) (rate(messaging_messages_consumed_total[5m]))
histogram_quantile(0.95, sum by (queue, event_type, le) (rate(messaging_message_processing_duration_seconds_bucket[5m])))
sum by (queue) (rate(messaging_retries_total[5m]))
messaging_connection_up
```

**Remediation:**

- No consumers → restart the owning service (`docker compose restart <service>`); it re-subscribes on start.
- Slow handlers → fix the dependency; scale the service (more replicas compete on the same queue). Raising `CONSUMER_PREFETCH` increases per-process concurrency but also database pool pressure.
- Persistent failures → see [dead letters](#dead-letters).
- Never purge a main queue to "fix" a backlog: it discards business events.

## Dead letters

**Alerts:** `MessagesDeadLettered` — any message dead-lettered in 15 minutes (warning); `RepeatedDeadLetters` — more than 10 archived dead letters from one queue in an hour (critical).

**Symptoms:** a workflow step silently did not happen for some entities (e.g. a notification not sent, a read model not updated); `dead_letters_open` above zero.

**How messages get here:** the consumer dead-letters a message when the envelope or payload is invalid (`invalid_message`), no handler exists (`unhandled_event_type`), the handler throws `NonRetryableError` (`non_retryable`), or all retries failed (`retries_exhausted`). Quorum queues also dead-letter natively after 10 deliveries. The worker archives every dead letter in `worker_db.dead_letters` (repeated failures of the same message increment `occurrences`).

**Diagnosis:**

```sh
# Open (ARCHIVED) dead letters, newest first
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:3009/admin/v1/dead-letters?status=ARCHIVED&pageSize=50' | jq
# Filter by original queue
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:3009/admin/v1/dead-letters?queue=notification-service.events' | jq
# Full record including body and headers
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3009/admin/v1/dead-letters/<id> | jq
```

Fields to read: `reason`, `lastError`, `originalQueue`, `eventType`, `correlationId`, `occurrences`. Then:

- Search logs of the owning service for the `correlationId` or message ID.
- `retries_exhausted` from `notification-service.events` with `SimulatedDeliveryError` is the intentional demo for recipients at `@bounce.test`.
- `invalid_message` usually means a producer/consumer contract mismatch — check `tests/contract` and the [event catalog](../development/event-catalog.md).

**Remediation:**

1. Fix the cause first (deploy the fix, restore the dependency, correct data).
2. **Replay** — republishes the original body to the original queue via the default exchange, so only the consumer that failed sees it again. Consumers are idempotent, so replaying an already-applied message is harmless.

   ```sh
   curl -s -X POST -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:3009/admin/v1/dead-letters/<id>/replay | jq
   ```

3. **Discard** — when the message must not be processed (e.g. obsolete, or handled manually):

   ```sh
   curl -s -X POST -H "Authorization: Bearer $TOKEN" \
     http://127.0.0.1:3009/admin/v1/dead-letters/<id>/discard | jq
   ```

Only `ARCHIVED` records can be replayed or discarded (`409 invalid_dead_letter_state` otherwise); records whose original queue is unknown cannot be replayed (`409 unknown_queue`). A replayed message that fails again is archived again with `occurrences` incremented. There is no bulk replay endpoint and no automatic deletion of dead-letter records.

## Outbox stalled

**Alert:** `OutboxPublishingStalled` — `outbox_oldest_pending_age_seconds` above 120 s for 5 minutes.

**Symptoms:** committed changes have no downstream effect (order created but no reservation); _Oldest pending outbox age_ and _Pending outbox rows_ rising for one service.

**Likely causes:** the service is disconnected from RabbitMQ (relay skips cycles while disconnected); publisher confirms timing out (broker under memory/disk alarm); the relay is failing repeatedly on specific rows (back-off up to 60 s); the service is down.

**Diagnosis:**

```sh
docker compose exec postgres psql -U postgres -d orders_db -c \
  "SELECT status, count(*), min(created_at), max(attempts) FROM outbox_events WHERE status <> 'PUBLISHED' GROUP BY status;"
docker compose exec postgres psql -U postgres -d orders_db -c \
  "SELECT id, event_type, attempts, available_at, left(last_error,200) FROM outbox_events WHERE status <> 'PUBLISHED' ORDER BY created_at LIMIT 20;"
docker compose logs --since 15m --no-log-prefix order-service | jq -R 'fromjson? | select((.message // "") | test("outbox"))'
```

```promql
sum by (service, outcome) (rate(outbox_events_relayed_total[5m]))
messaging_connection_up
```

Check broker alarms: `docker compose exec rabbitmq rabbitmq-diagnostics alarms`.

**Remediation:** restore broker connectivity ([broker unavailable](#broker-unavailable)); the relay resumes automatically and rows are never dropped. Rows stuck in `PUBLISHING` are re-claimed after the 30 s lease. Do **not** delete pending outbox rows — that loses events permanently. If a single row fails forever with a contract error, fix the producer and redeploy; editing `envelope` by hand should be a last resort with a reviewed SQL change.

## Broker unavailable

**Alert:** `BrokerConnectionLost` — `messaging_connection_up == 0` for 2 minutes in a service.

**Symptoms:** services report not ready (`rabbitmq` is a critical readiness check) and may be marked unhealthy; outbox backlogs grow; no messages consumed. HTTP requests that only write to PostgreSQL still succeed (events wait in the outbox).

**Likely causes:** RabbitMQ container down or restarting; memory or disk alarm (`vm_memory_high_watermark.relative = 0.6`, `disk_free_limit 1GB` locally); credential change; network issue.

**Diagnosis:**

```sh
docker compose ps rabbitmq
docker compose logs --tail=200 rabbitmq
docker compose exec rabbitmq rabbitmq-diagnostics status
docker compose exec rabbitmq rabbitmq-diagnostics alarms
docker compose logs --since 10m --no-log-prefix order-service | jq -R 'fromjson? | select((.message // "") | test("rabbitmq"))'
```

**Remediation:**

1. Restart the broker if it is down: `docker compose up -d rabbitmq`. Services reconnect automatically and re-declare their consumers.
2. Memory/disk alarm → free disk space or raise limits; publishers are blocked until the alarm clears.
3. After recovery, verify queues exist (the migrator declares them; services also assert their own queue on connect) and watch the outbox drain.
4. If the `rabbitmq-data` volume was lost, re-run the migrator to declare the topology: `docker compose run --rm migrator`. Messages that were in queues at the time are gone; outbox rows not yet published are not.

## Saga failures

**Alert:** `SagaFailureRateHigh` — more than 25 % of order sagas end cancelled or in review over 15 minutes.

**Symptoms:** many orders `CANCELLED`; customers receive cancellation emails.

**Likely causes and how to tell them apart** (`saga_completed_total{outcome, reason}`):

| `reason`                                    | Meaning                                                       | Typical cause                                                                    |
| ------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `out_of_stock`                              | Inventory could not reserve                                   | Real demand, or stock data wrong                                                 |
| `payment_failed`                            | Authorization declined or found failed on reconciliation      | Demo tokens `sim_card_declined` / `sim_insufficient_funds`, or provider problems |
| `reservation_expired`                       | Stock reservation TTL (15 min) passed before confirmation     | Payment step very slow, payment-service down                                     |
| `inventory_timeout`                         | No inventory answer within `SAGA_INVENTORY_TIMEOUT_MS` (60 s) | inventory-service down or its queue backlogged                                   |
| `manual_review` (outcome `requires_review`) | See [orders requiring review](#orders-requiring-review)       |                                                                                  |

```promql
sum by (outcome, reason) (increase(saga_completed_total[1h]))
sum by (step, decision) (increase(saga_step_timeouts_total[1h]))
sum by (outcome) (increase(inventory_reservations_total[1h]))
sum by (operation, outcome) (increase(payment_operations_total[1h]))
```

Inspect one order end to end (customer or admin token):

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/orders/<orderId> | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/orders/<orderId>/history | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/inventory/reservations/<orderId> | jq   # admin
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/v1/payments?orderId=<orderId>" | jq
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/v1/audit-events?subjectId=<orderId>" | jq  # admin
```

**Remediation:** depends on the reason — restock (`POST /api/v1/inventory/{productId}/adjustments`), restore the failing participant, or tune timeouts. Cancelled orders are terminal; customers must place a new order.

## Orders requiring review

**Alert:** `OrdersAwaitingManualReview` — at least one saga ended in `REQUIRES_REVIEW` in the last 30 minutes.

**What it means:** the saga could not reach a safe outcome automatically:

- payment outcome still unknown after `SAGA_MAX_PAYMENT_ATTEMPTS` (3) authorization requests;
- payment is `VOIDED`/`REFUNDED` while the order still awaits payment;
- inventory could not commit stock for an already-confirmed order (`InventoryCommitFailed`).

The order's `reviewReason` field states which. The customer receives an "order under review" email.

**Diagnosis:**

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8080/api/v1/orders?status=REQUIRES_REVIEW&pageSize=100' | jq '.data[] | {id, customerId, reviewReason, updatedAt}'
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/v1/payments?orderId=<orderId>" | jq
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/inventory/reservations/<orderId> | jq
```

Payment audit trail (`payment_events`) for the order:

```sh
docker compose exec postgres psql -U postgres -d payment_db -c \
  "SELECT e.created_at, e.action, e.outcome, e.detail FROM payment_events e JOIN payments p ON p.id = e.payment_id WHERE p.order_id = '<orderId>' ORDER BY e.id;"
```

**Remediation:**

- **Payment later resolves** (reconciliation finds it `AUTHORIZED` or `FAILED`): the late `PaymentAuthorized` / `PaymentFailed` event moves the order to `CONFIRMED` / `CANCELLED` automatically. Check whether the payment is still `PROCESSING` and whether `payment.reconcile` jobs are running (`worker_jobs_total{task="payment.reconcile"}`).
- **Order cannot be fulfilled or paid** → cancel as admin; compensation follows automatically (stock release or restock, void or refund):

  ```sh
  curl -s -X POST -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/orders/<orderId>/cancel | jq
  ```

- **Inventory commit failed but goods can be shipped** (e.g. stock arrived): there is **no endpoint to force-confirm** an order or re-run the commit. Options: cancel and ask the customer to reorder, or resolve with a reviewed SQL change in the owning databases. A dedicated admin "resolve review" action is a recommended extension, not implemented.

Record the decision in your ticketing system; the audit service records the resulting events (`OrderCancelled`, payment events).

## Database pool exhaustion

**Alerts:** `DatabasePoolExhausted` — requests waiting for a connection for 2 minutes (warning); `DatabasePoolNearCapacity` — more than 90 % of the pool in use for 10 minutes (info).

**Symptoms:** rising latency, then `500 internal_error` once the 5 s connection timeout is hit; _DB pool connections_ panel shows `waiting > 0`.

**Likely causes:** slow queries holding connections; long interactive transactions; a traffic spike beyond `DATABASE_POOL_SIZE` (default 10; 5 for audit-service and worker); consumer prefetch too high relative to pool size; PostgreSQL `max_connections` (200 locally) exhausted across all services and replicas.

**Diagnosis:**

```promql
max by (service, pool, state) (db_pool_connections)
max by (service, pool) (db_pool_max_connections)
```

```sh
docker compose exec postgres psql -U postgres -c \
  "SELECT datname, usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3,4 ORDER BY 5 DESC;"
docker compose exec postgres psql -U postgres -c \
  "SELECT pid, datname, now()-xact_start AS xact_age, state, wait_event_type, left(query,120) FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_age DESC LIMIT 20;"
docker compose exec postgres psql -U postgres -c "SHOW max_connections;"
```

**Remediation:**

- Fix the slow query or long transaction first; increasing the pool only moves the queue into PostgreSQL.
- Raise `DATABASE_POOL_SIZE` for the service only if PostgreSQL has headroom: total of (pool size × replicas) across all services must stay well below `max_connections`. Consider a connection pooler (e.g. PgBouncer in transaction mode) when replica counts grow.
- Lower `CONSUMER_PREFETCH` if message handlers are starving HTTP requests of connections.
- Statements are cut off after 10 s (`statement_timeout`); a blocked lock chain can be ended with `SELECT pg_cancel_backend(<pid>);` after confirming what the session is doing.
