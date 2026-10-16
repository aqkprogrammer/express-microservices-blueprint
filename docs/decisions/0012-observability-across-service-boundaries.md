# ADR-0012: Observability across service boundaries

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

One user action — placing an order — touches the gateway, order-service, product-service (synchronous HTTP), RabbitMQ, inventory-, payment-, notification- and audit-service, and scheduled maintenance commands. Diagnosing a failure requires following that action across HTTP calls _and_ asynchronous messages, including messages published seconds later by the outbox relay from a different call stack. Metrics must stay affordable at any traffic level.

## Decision

### Traces

- **OpenTelemetry Node SDK**, started before application code via `node --import ./dist/telemetry.js` (`packages/observability/src/telemetry.ts`). Because services are ES modules, the SDK registers OpenTelemetry's **ESM loader hook** (`@opentelemetry/instrumentation/hook.mjs`) so imported libraries can be patched.
- Instrumentations: `http`, `express`, `undici` (`fetch`), `pg`, `ioredis`, `pino` (log export only). Health and metrics endpoints are not traced.
- **HTTP**: W3C `traceparent`/`tracestate` are injected by the undici instrumentation for outgoing `fetch` calls. The gateway strips client-supplied trace headers so external callers cannot join or forge traces.
- **Messaging**: `enqueueEvent` stores the current trace context on the **outbox row** (`headers` column) at write time. The relay starts a `PRODUCER` span whose parent is that stored context and injects fresh W3C headers into the AMQP message. Consumers extract the context from AMQP headers and run the handler in a `CONSUMER` span. One trace therefore spans the HTTP request and the asynchronous saga steps it causes.
- Export via OTLP/HTTP to Jaeger v2 (UI on port 16686). Sampling uses the standard `OTEL_TRACES_SAMPLER` variables (`parentbased_traceidratio`, ratio 1.0 locally).

### Logs

- **Pino** JSON logs to stdout. A mixin adds `requestId`, `correlationId`, `causationId`, `userId`, `traceId` and `spanId` from the async-local request context and the active span.
- A fixed redaction list removes passwords, tokens, secrets, authorization headers and cookies before any sink sees them.
- Optionally (`OTEL_LOGS_EXPORTER=otlp`) logs are also exported via OTLP to Loki, where Grafana links `trace_id` to Jaeger.

### Correlation and causation

- The gateway (and every service) accepts or creates `X-Request-Id` and `X-Correlation-Id` (validated against `^[A-Za-z0-9._:-]{1,128}$`), returns them in responses and forwards them upstream.
- Every message envelope carries `correlationId` (the business transaction; `OrderCreated` uses the order ID) and `causationId` (the ID of the request or message that caused it). Consumers run handlers with `requestId = envelope.id` and `correlationId = envelope.correlationId`, so events they emit continue the chain.

### Metrics

- `prom-client` registry per process with a `service` default label; `/metrics` on each service's internal port and on port 9464 for the gateway (never on the public port).
- **Bounded labels only**: HTTP metrics use the matched route template (e.g. `/api/v1/orders/:orderId`) or the gateway's fixed route label, never raw URLs; no user, order or message IDs in labels. Unmatched requests are labelled `unmatched`.
- RED metrics for HTTP, plus messaging, outbox, saga, cache, DB-pool and domain counters (catalogue in [observability](../operations/observability.md)).

## Consequences

### Positive

- A request ID from a client error report leads to logs, and from there to the full distributed trace including asynchronous steps.
- Saga problems are visible as metrics (`saga_completed_total`, `saga_step_timeouts_total`) before customers report them.
- Metric cardinality does not grow with traffic or data volume.

### Negative and trade-offs

- The ESM loader hook must be registered before any instrumented module is imported; running `node dist/main.js` without `--import` silently disables instrumentation.
- Traces are only as complete as sampling allows; with ratio sampling, some saga steps of unsampled orders have no spans (logs still carry correlation IDs).
- Events emitted by scheduled maintenance (timeouts, reservation expiry) carry the maintenance command's correlation ID, not the order's; search by order ID (subject) for those.
- Storing trace context on outbox rows adds a small `jsonb` column per event.
- Locally Jaeger stores traces in memory (lost on restart) and Loki keeps 7 days; production needs durable backends.

## Alternatives considered

| Option                                     | Why not chosen                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| CommonJS with `--require` instrumentation  | Would avoid the ESM hook but give up native ES modules across the codebase.                                |
| Vendor agents (APM SDKs)                   | Lock-in; OpenTelemetry keeps the backend replaceable.                                                      |
| Correlation IDs only, no tracing           | Loses timing and causal structure across services.                                                         |
| Trace context created at publish time only | Would detach consumer spans from the originating request because the relay runs on a different call stack. |

## Operational cost

- Collector/backends for traces, logs and metrics (Jaeger, Loki, Prometheus, Grafana locally; managed or self-hosted equivalents in production) and their storage.
- Sampling and retention tuning; dashboards and alerts are examples and need tuning ([observability](../operations/observability.md)).
