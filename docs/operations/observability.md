# Observability

Logs, metrics and traces are wired into every service through shared packages (`packages/logger`, `packages/observability`, `packages/http-kit`, `packages/messaging`). The design rationale is in [ADR-0012](../decisions/0012-observability-across-service-boundaries.md).

| Signal  | Produced by                                                         | Local backend                             | Where to look                                   |
| ------- | ------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| Logs    | Pino JSON on stdout (+ OTLP export)                                 | Docker log driver; Loki (7-day retention) | `docker compose logs`, Grafana → Explore → Loki |
| Metrics | `prom-client`, `/metrics` per service (gateway: internal port 9464) | Prometheus (3-day retention)              | <http://localhost:9090>, Grafana dashboards     |
| Traces  | OpenTelemetry Node SDK, OTLP/HTTP                                   | Jaeger v2, in memory (lost on restart)    | <http://localhost:16686>                        |

The local backends are sized for a laptop. Production needs durable storage, retention and access control for each signal.

## Logs

Every line is one JSON object with at least `level`, `time`, `service`, `env` and `message`. During a request or message handler the logger adds:

| Field               | Meaning                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `requestId`         | `X-Request-Id` of the HTTP request (or the envelope `id` while handling a message)         |
| `correlationId`     | `X-Correlation-Id`, or the envelope's `correlationId` (the order ID for order-saga events) |
| `causationId`       | ID of the message that caused this work                                                    |
| `userId`            | Authenticated user, when known                                                             |
| `traceId`, `spanId` | Active OpenTelemetry span                                                                  |

Each HTTP request produces one `request completed` line with `http.method`, `http.route` (route template), `http.statusCode` and `durationMs`; health and metrics requests are not logged. Errors are logged with a serialised `err` and a coarse `errorClass`.

**Redaction:** passwords, tokens, secrets, `authorization`, `cookie`, `set-cookie` and `x-internal-token` values are replaced with `[REDACTED]` before reaching any sink (`packages/logger/src/logger.ts`). Do not log request bodies wholesale; the redaction list is a safety net, not a licence.

Useful commands:

```sh
docker compose logs -f --tail=100 order-service
docker compose logs --since 30m --no-log-prefix order-service | jq -R 'fromjson? | select(.level=="error")'
```

In Grafana (Explore → Loki), logs are labelled by `service_name`, e.g. `{service_name="order-service"}`. OTLP log attributes are stored as structured metadata; filter them with label filter expressions after the stream selector. The Loki data source links `trace_id` to Jaeger.

## Find a trace from a request ID

Every response carries `X-Request-Id` (also included as `requestId` in problem documents). The gateway forwards the same ID to the upstream service, so both log lines share it.

1. Get the request ID from the client, the response header or the problem document.
2. Find the log line and its trace ID:

   ```sh
   docker compose logs --no-log-prefix api-gateway order-service \
     | jq -R --arg id "<request-id>" 'fromjson? | select(.requestId == $id) | {service, message, traceId}'
   ```

3. Open `http://localhost:16686/trace/<traceId>` in Jaeger. The trace contains the gateway span, the service's HTTP and database spans, outgoing `fetch` calls, and — because trace context travels on outbox rows and AMQP headers — the producer and consumer spans of the events the request caused (e.g. `OrderCreated` → inventory reservation → payment authorization).

For asynchronous work, search by business identifier instead: the order ID is the `correlationId` of most saga events (`GET /api/v1/audit-events?correlationId=<orderId>` or `?subjectId=<orderId>` as admin). Events emitted by scheduled maintenance (timeouts, reservation expiry) carry the maintenance command's correlation ID, so search those by order ID as subject.

Traces depend on sampling (`OTEL_TRACES_SAMPLER_ARG`, 1.0 locally). With a lower ratio, not every request has a trace; correlation IDs in logs still work.

## Metrics catalogue

Every metric carries a `service` label. Labels are bounded by design: route templates, queue names, event types and outcome enums — never user, order or message IDs.

### HTTP

| Metric                                 | Type      | Labels                           | Notes                                                                               |
| -------------------------------------- | --------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `http_requests_total`                  | counter   | `method`, `route`, `status_code` | `route` is the Express route template, the gateway's route label, or `unmatched`    |
| `http_request_duration_seconds`        | histogram | `method`, `route`, `status_code` |                                                                                     |
| `http_requests_in_flight`              | gauge     | —                                |                                                                                     |
| `http_client_requests_total`           | counter   | `target`, `method`, `outcome`    | Service-to-service calls (`success`, `http_error`, `network_error`, `circuit_open`) |
| `http_client_request_duration_seconds` | histogram | `target`, `method`               |                                                                                     |
| `http_client_circuit_open`             | gauge     | `target`                         | 1 while open                                                                        |
| `gateway_upstream_errors_total`        | counter   | `upstream`, `kind`               | `timeout`, `connection`, `circuit_open`, `stream`                                   |
| `gateway_upstream_circuit_open`        | gauge     | `upstream`                       | 1 while open                                                                        |

### Messaging and outbox

| Metric                                          | Type      | Labels                                                                           |
| ----------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `messaging_messages_consumed_total`             | counter   | `queue`, `event_type`, `outcome` (`success`, `retry`, `dead_letter`, `requeued`) |
| `messaging_message_processing_duration_seconds` | histogram | `queue`, `event_type`                                                            |
| `messaging_messages_in_flight`                  | gauge     | `queue`                                                                          |
| `messaging_retries_total`                       | counter   | `queue`                                                                          |
| `messaging_dead_lettered_total`                 | counter   | `queue`, `reason`                                                                |
| `messaging_messages_published_total`            | counter   | `exchange`, `outcome`                                                            |
| `messaging_connection_up`                       | gauge     | —                                                                                |
| `outbox_events_relayed_total`                   | counter   | `outcome` (`published`, `failed`)                                                |
| `outbox_pending_events`                         | gauge     | —                                                                                |
| `outbox_oldest_pending_age_seconds`             | gauge     | —                                                                                |

RabbitMQ's own metrics (queue depth, rates) are scraped from `rabbitmq:15692` with per-object metrics enabled.

### Saga and domain

| Metric                          | Type      | Labels                                               | Service      |
| ------------------------------- | --------- | ---------------------------------------------------- | ------------ |
| `saga_completed_total`          | counter   | `outcome`, `reason`                                  | order        |
| `saga_duration_seconds`         | histogram | `outcome`                                            | order        |
| `saga_step_timeouts_total`      | counter   | `step`, `decision`                                   | order        |
| `saga_events_ignored_total`     | counter   | `event_type`                                         | order        |
| `orders_created_total`          | counter   | `replayed`                                           | order        |
| `inventory_reservations_total`  | counter   | `outcome`                                            | inventory    |
| `payment_operations_total`      | counter   | `operation`, `outcome`                               | payment      |
| `auth_operations_total`         | counter   | `operation`, `outcome`                               | auth         |
| `notifications_delivered_total` | counter   | `template`, `outcome`                                | notification |
| `audit_records_total`           | counter   | `category`                                           | audit        |
| `cache_requests_total`          | counter   | `cache`, `result` (`hit`, `miss`, `bypass`, `error`) | product      |

### Infrastructure and worker

| Metric                        | Type      | Labels                                                                                       |
| ----------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `db_pool_connections`         | gauge     | `pool`, `state` (`total`, `idle`, `waiting`)                                                 |
| `db_pool_max_connections`     | gauge     | `pool`                                                                                       |
| `worker_jobs_total`           | counter   | `task`, `outcome` (`published`, `published_without_lock`, `not_leader`, `failed`, `skipped`) |
| `worker_job_duration_seconds` | histogram | `task`                                                                                       |
| `dead_letters_archived_total` | counter   | `queue`, `reason`                                                                            |
| `dead_letters_replayed_total` | counter   | `queue`                                                                                      |
| `dead_letters_open`           | gauge     | —                                                                                            |

Default Node.js process metrics (`process_*`, `nodejs_*`) are collected as well.

## Dashboards

Provisioned automatically into the Grafana folder _Express Microservices Blueprint_ from `infrastructure/grafana/dashboards/` (regenerate with `npm run dashboards:generate`):

| Dashboard                | URL                                     | Panels                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Services overview (RED)  | <http://localhost:3000/d/emb-services>  | Request rate, 5xx ratio, p95 latency by service and route, in-flight requests, 4xx by status, gateway upstream errors, service-to-service calls, open circuits, product cache results, DB pool, process memory                                   |
| Messaging, outbox & saga | <http://localhost:3000/d/emb-messaging> | Saga outcomes, duration, timeouts, ignored events, reservations, consumption by outcome, handler p95, retries, dead letters, open dead letters, queue depth, broker connection, outbox relayed/pending/oldest age, scheduled jobs, notifications |

## Alerts

`infrastructure/prometheus/alerts.yml` defines 12 example rules. **They are starting points for a local demo and must be tuned** against real traffic, SLOs and on-call policy before production use. The local stack has no Alertmanager, so alerts only appear at <http://localhost:9090/alerts>.

| Alert                        | Condition (summary)                         | Severity | Runbook                                                         |
| ---------------------------- | ------------------------------------------- | -------- | --------------------------------------------------------------- |
| `ServiceDown`                | scrape target down 1 min                    | critical | [service-down](runbook.md#service-down)                         |
| `HighHttpErrorRate`          | 5xx ratio > 5 % for 5 min                   | warning  | [elevated-error-rate](runbook.md#elevated-error-rate)           |
| `HighHttpLatencyP95`         | p95 > 1 s for 10 min                        | warning  | [latency](runbook.md#latency)                                   |
| `RabbitMQQueueBacklog`       | > 1000 ready messages for 10 min            | warning  | [queue-backlog](runbook.md#queue-backlog)                       |
| `MessagesDeadLettered`       | any dead-lettered message in 15 min         | warning  | [dead-letters](runbook.md#dead-letters)                         |
| `RepeatedDeadLetters`        | > 10 archived from one queue in 1 h         | critical | [dead-letters](runbook.md#dead-letters)                         |
| `OutboxPublishingStalled`    | oldest pending outbox row > 120 s for 5 min | critical | [outbox-stalled](runbook.md#outbox-stalled)                     |
| `BrokerConnectionLost`       | `messaging_connection_up == 0` for 2 min    | critical | [broker-unavailable](runbook.md#broker-unavailable)             |
| `SagaFailureRateHigh`        | > 25 % of sagas not confirmed over 15 min   | warning  | [saga-failures](runbook.md#saga-failures)                       |
| `OrdersAwaitingManualReview` | any `requires_review` outcome in 30 min     | warning  | [orders-requiring-review](runbook.md#orders-requiring-review)   |
| `DatabasePoolExhausted`      | waiting connections for 2 min               | warning  | [database-pool-exhaustion](runbook.md#database-pool-exhaustion) |
| `DatabasePoolNearCapacity`   | > 90 % of pool used for 10 min              | info     | [database-pool-exhaustion](runbook.md#database-pool-exhaustion) |

Gaps worth adding in production (not included): Redis availability and fail-open signals (`cache_requests_total{result="error"}`, `worker_jobs_total{outcome="published_without_lock"}`), certificate expiry, disk usage, PostgreSQL replication and backup freshness, and SLO-based burn-rate alerts.

## Configuration

| Variable                                                 | Effect                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `LOG_LEVEL`                                              | `fatal` … `trace`, `silent` (default `info`)                           |
| `OTEL_SDK_DISABLED`                                      | `true` disables tracing and OTLP log export                            |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                     | Trace endpoint (Compose: `http://jaeger:4318/v1/traces`)               |
| `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `otlp` + Loki OTLP endpoint (Compose: `http://loki:3100/otlp/v1/logs`) |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`         | Sampling (Compose: `parentbased_traceidratio`, `1.0`)                  |
| `METRICS_ENABLED`                                        | `false` removes `/metrics` from a service                              |

Instrumentation only works when the process starts with `node --import ./dist/telemetry.js` (the image's default command), because the ESM loader hook must be registered before application modules load.
