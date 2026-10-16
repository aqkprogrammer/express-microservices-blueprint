# 9. Docker Compose deployment

[← Observability](08-observability.md) · [Index](README.md) · Next: [Kubernetes (optional) →](10-kubernetes.md)

`docker compose up --build` (project name `emb`, [`docker-compose.yml`](../../docker-compose.yml))
starts the complete environment on one private bridge network. Only the ports below are
published, and every one binds to **127.0.0.1**; PostgreSQL, RabbitMQ AMQP and Redis are not
published at all.

```mermaid
flowchart TB
    dev["Developer machine<br/>127.0.0.1 only"]

    subgraph compose["docker compose project emb (private network)"]
        subgraph oneshot["One-shot release steps"]
            keygen["keygen<br/>ES256 dev key → volume jwt-keys"]
            migrator["migrator<br/>prisma migrate deploy per database<br/>seed product + inventory<br/>declare RabbitMQ topology"]
        end

        subgraph infra["Infrastructure"]
            postgres[("postgres:17-alpine<br/>one DB + role per service")]
            rabbitmq{{"rabbitmq:4.1-management"}}
            redis[("redis:8-alpine<br/>no persistence · 128 MB LRU")]
            mailpit["mailpit<br/>SMTP 1025"]
        end

        subgraph apps["Application containers (one image per SERVICE, non-root uid 1000)"]
            gateway["api-gateway :8080<br/>metrics :9464"]
            services["auth :3001 · user :3002 · product :3003<br/>inventory :3004 · order :3005 · payment :3006<br/>notification :3007 · audit :3008"]
            worker["worker :3009"]
        end

        subgraph observability["Observability"]
            jaeger["jaeger 2.9"]
            loki["loki 3.5"]
            prometheus["prometheus 3.5"]
            grafana["grafana 12.1"]
        end
    end

    dev -->|"8080 public API + /docs"| gateway
    dev -->|"15672 management UI"| rabbitmq
    dev -->|"8025 email UI"| mailpit
    dev -->|"16686"| jaeger
    dev -->|"9090"| prometheus
    dev -->|"3000"| grafana
    dev -->|"3009 dead-letter admin API"| worker

    postgres -->|"healthy"| migrator
    rabbitmq -->|"healthy"| migrator
    migrator -->|"completed successfully"| services
    migrator -->|"completed successfully"| worker
    keygen -->|"completed successfully"| services
    services -->|"healthy (/health/ready)"| gateway
```

## Volumes

| Volume            | Mounted by                                  | Contents                                                                           |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `postgres-data`   | postgres                                    | All service databases                                                              |
| `rabbitmq-data`   | rabbitmq                                    | Quorum queue data, definitions                                                     |
| `jwt-keys`        | keygen (rw), auth-service (ro, `/run/keys`) | Development ES256 signing key                                                      |
| `loki-data`       | loki                                        | Log chunks                                                                         |
| `prometheus-data` | prometheus                                  | TSDB (3-day retention)                                                             |
| `grafana-data`    | grafana                                     | Grafana state (dashboards are provisioned read-only from `infrastructure/grafana`) |

## Startup order

```mermaid
flowchart LR
    pg["postgres healthy"] --> mig["migrator exits 0"]
    mq["rabbitmq healthy"] --> mig
    kg["keygen exits 0"] --> auth["auth-service healthy"]
    mig --> auth
    mig --> others["user · inventory · order · payment<br/>notification · audit healthy"]
    mig --> prod["product-service healthy"]
    mig --> wk["worker healthy"]
    redis["redis healthy"] --> prod
    redis --> wk
    auth --> gw["api-gateway healthy"]
    others --> gw
    prod --> gw
    redis --> gw
```

- Every service and the worker depend on `migrator` (completed successfully), `postgres` and
  `rabbitmq` (healthy); product-service and the worker also wait for Redis, auth-service for
  `keygen`, and notification-service for Mailpit. The gateway starts once Redis and all eight
  services are healthy.
- Health checks call `/health/ready`, which returns 503 while PostgreSQL or RabbitMQ (critical
  checks) are unavailable; Redis is a non-critical check (status `degraded`) for product-service
  and the gateway.
- Containers run with `init: true`, `restart: unless-stopped`, a 20 s stop grace period for
  graceful shutdown, memory limits (256M per service, 384M for auth-service) and size-capped
  JSON logs.
- Images come from one multi-stage Dockerfile,
  [`infrastructure/docker/node-service.Dockerfile`](../../infrastructure/docker/node-service.Dockerfile)
  (`runtime` target per `SERVICE` build-arg, plus the `migrator` target).
