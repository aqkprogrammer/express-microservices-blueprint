# 8. Observability and tracing

[← Authentication](07-authentication.md) · [Index](README.md) · Next: [Docker Compose deployment →](09-docker-compose.md)

Every Node process preloads the OpenTelemetry NodeSDK with `node --import` (plus the ESM loader
hook) from [`packages/observability`](../../packages/observability). Instrumentations: `http`,
`express`, `undici` (fetch), `pg`, `ioredis` and `pino` (log export). Exporter endpoints use the
standard `OTEL_EXPORTER_OTLP_*` variables.

```mermaid
flowchart LR
    subgraph svc["Each service process"]
        sdk["OpenTelemetry NodeSDK<br/>http · express · undici · pg · ioredis · pino"]
        pino["Pino JSON logs<br/>requestId · correlationId · causationId<br/>userId · traceId · spanId · redaction"]
        metrics["prom-client registry<br/>GET /metrics"]
    end

    sdk -->|"OTLP/HTTP traces :4318"| jaeger["Jaeger v2<br/>UI :16686"]
    pino -->|"OTLP/HTTP logs /otlp/v1/logs"| loki["Loki<br/>label service_name"]
    prom["Prometheus :9090<br/>12 alert rules"] -->|"scrape every 15 s<br/>services · gateway :9464 · RabbitMQ :15692"| metrics
    grafana["Grafana :3000<br/>services-overview · messaging-saga"] --> prom
    grafana --> loki
    grafana --> jaeger
    loki -.->|"derived field trace_id → Jaeger"| jaeger
```

## Trace context end to end

One order produces a single trace across HTTP, the outbox and RabbitMQ: the trace context is
stored in the outbox row's `headers` column at write time and travels as W3C `traceparent` /
`tracestate` AMQP headers.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant G as api-gateway
    participant O as order-service
    participant DB as orders_db outbox_events
    participant R as OutboxRelay
    participant MQ as RabbitMQ
    participant I as inventory-service

    C->>G: POST /api/v1/orders (inbound traceparent is stripped)
    Note over G: server span = trace root
    G->>O: fetch, undici instrumentation injects traceparent
    Note over O: server span (child) · pg spans · logs carry traceId and spanId
    O->>DB: INSERT outbox row with headers.traceparent of the active span
    R->>DB: claim row
    Note over R: producer span domain.events publish OrderCreated<br/>parent = traceparent stored on the row
    R->>MQ: publish with traceparent re-injected + x-correlation-id
    MQ->>I: deliver
    Note over I: consumer span, parent extracted from AMQP headers<br/>its own outbox rows continue the same trace
```

## Signals at a glance

| Signal      | Where it goes                                                                 | Examples                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traces      | Jaeger (OTLP 4318)                                                            | HTTP server/client spans, `pg`, `ioredis`, outbox producer and consumer spans                                                                       |
| Logs        | Loki (OTLP), stdout JSON                                                      | Correlated by `traceId`, `requestId`, `correlationId` (the order ID for saga events)                                                                |
| RED metrics | Prometheus                                                                    | `http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`                                                                   |
| Messaging   | Prometheus                                                                    | `messaging_messages_consumed_total`, `messaging_retries_total`, `messaging_dead_lettered_total`, `messaging_connection_up`, `outbox_pending_events` |
| Saga        | Prometheus                                                                    | `saga_completed_total`, `saga_duration_seconds`, `saga_step_timeouts_total`                                                                         |
| Alerts      | Prometheus rules ([`alerts.yml`](../../infrastructure/prometheus/alerts.yml)) | `ServiceDown`, `OutboxPublishingStalled`, `BrokerConnectionLost`, `MessagesDeadLettered`, `SagaFailureRateHigh`, … each linking a runbook anchor    |

Sampling is `parentbased_traceidratio` (1.0 in Compose). The gateway serves metrics on an internal
port (9464) so `/metrics` is never reachable through the public API.
