# 1. System overview

[← Architecture index](README.md) · Next: [Request lifecycle →](02-request-lifecycle.md)

The blueprint is eight Express + TypeScript services behind one API gateway, plus a background
worker (services are grouped in pairs below to keep the diagram readable). Each service owns its PostgreSQL database and talks to the others asynchronously through
RabbitMQ; the only synchronous service-to-service calls are order-service's price lookup
(product-service) and payment reconciliation (payment-service), plus every service fetching the
JWKS from auth-service to verify access tokens.

```mermaid
flowchart TB
    client["Clients<br/>browser / mobile / API"]
    gw["api-gateway :8080<br/>rate limit · proxy · circuit breaker<br/>request IDs · Swagger UI /docs"]
    redis[("Redis 8<br/>rate limits · product cache · scheduler lock")]

    subgraph services["Services"]
        direction LR
        identity["auth-service :3001<br/>user-service :3002"]
        catalog["product-service :3003<br/>inventory-service :3004"]
        ordering["order-service :3005 saga orchestrator<br/>payment-service :3006 simulator"]
        support["notification-service :3007<br/>audit-service :3008"]
        worker["worker :3009<br/>scheduler · dead-letter archive"]
    end

    pg[("PostgreSQL 17<br/>database + role per service")]
    mq{{"RabbitMQ 4.1<br/>domain.events · maintenance.commands · dead-letters"}}
    mailpit["Mailpit<br/>SMTP sink"]

    subgraph obs["Observability"]
        direction LR
        jaeger["Jaeger<br/>traces"]
        loki["Loki<br/>logs"]
        prom["Prometheus<br/>metrics + alerts"]
        grafana["Grafana<br/>dashboards"]
    end

    client -->|"HTTP :8080"| gw
    gw -->|"rate-limit counters"| redis
    gw -->|"/api/v1/* proxy"| identity
    gw --> catalog
    gw --> ordering
    gw --> support
    catalog -->|"cache-aside"| redis
    worker -->|"leader lock"| redis
    services -->|"SQL, own database only"| pg
    services <-.->|"outbox → publish · consume"| mq
    support -->|"SMTP"| mailpit
    services -.->|"OTLP traces + logs · /metrics"| obs
```

![Static system overview: clients reach api-gateway on :8080, which proxies to eight services; services use PostgreSQL, RabbitMQ and Redis and export telemetry to Jaeger, Loki and Prometheus](../assets/animated/system-overview.svg)

_Static image (no animation) of the same architecture, used as the README hero. The Mermaid
diagram above is the text-based, accessible source of truth._

## Key points

- **Token verification without a call per request.** Every service verifies ES256 access tokens
  locally against auth-service's JWKS (`/.well-known/jwks.json`, cached and refreshed only on an
  unknown `kid`); the edge is omitted above to keep the diagram readable
  ([page 7](07-authentication.md)).
- **One public entry point.** Only `api-gateway` serves the public API. It never routes
  `/internal/*`, `/metrics`, `/health/*` or `/admin/*` paths of the services
  ([`apps/api-gateway/src/routes.ts`](../../apps/api-gateway/src/routes.ts)).
- **Database per service.** Each service connects with its own role to its own database
  (`auth_db`, `users_db`, `product_db`, `inventory_db`, `orders_db`, `payment_db`,
  `notification_db`, `audit_db`, `worker_db`); `PUBLIC CONNECT` is revoked, so no service can read
  another's tables.
- **Asynchronous by default.** Every domain event is written to the service's `outbox_events`
  table in the same transaction as the state change and relayed to RabbitMQ
  ([page 5](05-transactional-outbox.md)). Consumers are idempotent through `processed_messages`.
- **Worker.** Publishes `MaintenanceRequested.v1` commands on a schedule (reservation expiry, saga
  timeouts, payment reconciliation, audit retention, cleanup) and archives dead letters with an
  admin replay API that is only reachable on `127.0.0.1:3009`.
- **Payments are simulated.** `payment-service` is a local simulator; it never handles card data.
