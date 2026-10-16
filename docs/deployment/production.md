# Production deployment guidance

> **Everything here is optional guidance.** The repository ships a local Docker Compose environment and example Kubernetes manifests; it does not ship a production platform. Payment processing is a simulator ([payment-service](../../apps/payment-service)) and must be replaced before handling real money.

## A practical progression

Pick the simplest platform that meets your needs; move up only when a concrete need appears ([ADR-0013](../decisions/0013-when-kubernetes-becomes-worthwhile.md)).

| Stage                                                                            | Good for                                                                                                                     | What you take from this repo                                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker Compose on one VM**                                                     | demos, internal tools, low traffic where a few minutes of downtime per deploy is acceptable                                  | `docker-compose.yml` with managed or carefully backed-up data services; TLS-terminating reverse proxy in front of the gateway                            |
| **Managed containers** — AWS ECS/Fargate, Google Cloud Run, Azure Container Apps | most small teams: no cluster to operate, rolling deploys, autoscaling, secret-store integration                              | the same images (`runtime` target per `SERVICE`), the `migrator` image as a one-off task before each release, health endpoints for the platform's checks |
| **Kubernetes**                                                                   | many services and teams, a platform team or managed Kubernetes, need for NetworkPolicies / Pod Security / custom autoscaling | [`infrastructure/kubernetes`](kubernetes.md)                                                                                                             |

In every stage, run PostgreSQL, RabbitMQ and Redis as **managed services** (or with mature operators) rather than hand-rolled containers. Request-driven scale-to-zero platforms (e.g. Cloud Run's default mode) do not suit the services' long-lived RabbitMQ consumers and outbox relays: keep at least one instance always running with CPU always allocated.

What the services already provide for any orchestrator: stateless processes; configuration from environment variables validated at startup; `<NAME>_FILE` variants for every setting so secrets can be mounted as files; `/health/live` and `/health/ready` (readiness checks dependencies and fails as soon as shutdown begins); graceful SIGTERM handling (stop accepting HTTP, finish in-flight work, stop consumers, close connections, bounded by `SHUTDOWN_TIMEOUT_MS`, default 15 s); non-root images; JSON logs on stdout; OTLP traces/logs; Prometheus metrics.

## TLS termination

- Terminate public TLS at a load balancer or ingress (cert-manager, cloud certificate managers) in front of `api-gateway`; only the gateway is exposed.
- Set `COOKIE_SECURE=true` (the default) so the refresh-token cookie is only sent over HTTPS, and set `CORS_ALLOWED_ORIGINS` to your real web origin.
- The gateway trusts `X-Forwarded-For` from private-range proxies (`TRUST_PROXY`, default `loopback, linklocal, uniquelocal`). Per-IP rate limits only see real client IPs if your load balancer preserves them (e.g. `externalTrafficPolicy: Local` or PROXY protocol); adjust `TRUST_PROXY` to your proxy topology.
- Internal service-to-service HTTP is plain HTTP inside a private network, protected by network policy and, for `/internal/*`, a shared token. If you need encryption or workload identity in transit, add a service mesh (mTLS) rather than changing the services.
- Use TLS to managed backing services: `sslmode=require` (or `verify-full`) in `DATABASE_URL`, `amqps://` for RabbitMQ, `rediss://` for Redis.

## Secrets management

- Never put credentials in images, ConfigMaps, Compose files or Git. The `.env` / `local-dev-*` defaults exist for workstations only.
- Store secrets in a secret manager (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, HashiCorp Vault) and inject them as environment variables or files. On Kubernetes: External Secrets Operator, Sealed Secrets or the Secrets Store CSI Driver ([details](kubernetes.md#secrets)).
- The JWT signing key (ES256) belongs in the secret store and is mounted via `JWT_PRIVATE_KEY_FILE`. Rotate it by deploying the new key while publishing the old public key through `JWT_PREVIOUS_PUBLIC_KEY` for at least the access-token lifetime (15 minutes).
- `INTERNAL_API_TOKEN` (≥ 32 random characters) is shared by order, product and payment; rotate it with a coordinated restart.
- Remove `ADMIN_BOOTSTRAP_PASSWORD` after the first start and change the admin password.

## Database roles: split migration and runtime

Docker Compose creates **one login role per database that owns it** (`orders_svc` owns `orders_db`, …). That is simple, and already isolates services from each other's data (PUBLIC `CONNECT` is revoked), but the running service can also alter or drop its schema. In production, use two roles per database:

| Role                     | Used by                                      | Privileges                                                                                                      |
| ------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `<db>_owner` (migration) | the migrator only (`<SERVICE>_DATABASE_URL`) | owns the schema and tables; DDL                                                                                 |
| `<db>_app` (runtime)     | the service (`DATABASE_URL`)                 | `CONNECT`; `USAGE` on schema `public`; `SELECT, INSERT, UPDATE, DELETE` on tables; `USAGE, SELECT` on sequences |

Grant runtime privileges for future tables too, as the owner role, so new migrations need no manual grants:

```sql
-- run as orders_owner in orders_db
GRANT USAGE ON SCHEMA public TO orders_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orders_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orders_app;
ALTER DEFAULT PRIVILEGES FOR ROLE orders_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orders_app;
ALTER DEFAULT PRIVILEGES FOR ROLE orders_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO orders_app;
```

The services run no DDL at runtime, so this split needs no code change — only different connection strings (`emb-migration-db` vs `<service>-db` in the Kubernetes manifests). You can tighten further per table (for example, audit records are append-only by trigger; the runtime role still needs `DELETE` for the retention task). Test the split in staging before production: a missing grant shows up as a permission error at the first query that needs it.

Size connection pools against the server limit: each replica opens up to `DATABASE_POOL_SIZE` connections (default 10, audit/worker 5). With autoscaling, `max replicas × pool size` per service must fit under `max_connections`; otherwise add PgBouncer (transaction pooling) or lower the pool size. The `DatabasePoolExhausted` alert ([runbook](../operations/runbook.md#database-pool-exhaustion)) covers the symptom.

## PostgreSQL backups and restore

The local procedures are in [backup and restore](../operations/backup-restore.md). For production:

- **Point-in-time recovery (PITR)** is the baseline: continuous WAL archiving plus periodic base backups, provided by managed services (RDS/Aurora, Cloud SQL, Azure Database for PostgreSQL) or by pgBackRest / WAL-G / Barman (CloudNativePG uses Barman Cloud or plugins). PITR lets you restore to just before an incident, not only to the last nightly dump.
- **Logical dumps** (`pg_dump -Fc` per service database, `pg_restore --clean --if-exists`) remain useful for single-database restores, migrations between providers and long-term archives. They are point-in-time per database only.
- Each service has its own database, so backups of different databases are **not mutually consistent**. Restoring one service to an earlier point can leave sagas and read models out of step; the consequences and reconciliation steps are described in [backup and restore](../operations/backup-restore.md#consistency-across-services). For disaster recovery, restore all databases to the same timestamp where the platform supports it (one PITR-capable cluster hosting all service databases makes this easier).
- Encrypt backups, restrict access (they contain personal data), set retention to match your data-protection obligations, and **run restore drills** regularly. Re-run the migrator after a restore.

## RabbitMQ

- Run a 3-node cluster (managed, e.g. Amazon MQ for RabbitMQ / CloudAMQP, or the RabbitMQ Cluster Operator). The service queues are **quorum queues** (`x-queue-type: quorum`, delivery limit 10, dead-lettering to `dead-letters`), which replicate across nodes and need a majority to accept writes — three nodes tolerate one failure.
- Retry queues (`<queue>.retry.N`) are durable **classic** queues with a TTL. They are not replicated: a message waiting for a retry lives on one node and survives restarts, but not the loss of that node's disk. Treat a broker node loss as an incident and check the dead-letter archive and stuck sagas afterwards.
- Publishers use confirms and persistent messages; the transactional outbox means a broker outage delays events instead of losing them (`OutboxPublishingStalled` alert).
- The migrator declares the topology (exchanges, queues, bindings) and therefore needs `configure` permission; the services need `read`/`write` on their own queues. Create separate users if you want to restrict that.
- Monitor queue depth, unacked messages and the `dead-letters` queue; the Prometheus plugin endpoint (`:15692`) is scraped locally.

## Redis: cache only

Redis holds the product cache, gateway rate-limit counters and the worker scheduler's leader lock — nothing that must survive a restart ([ADR-0007](../decisions/0007-redis-not-system-of-record.md)). A managed single-node or primary/replica instance without persistence, with `maxmemory` and an LRU eviction policy, is sufficient. All three uses **fail open**: if Redis is down, product reads go to PostgreSQL, rate limits are not enforced (the gateway keeps serving), and the scheduler publishes maintenance commands without the lock. Size PostgreSQL for cache-miss traffic and consider an edge rate limit (WAF/load balancer) for when Redis is unavailable.

## Horizontal scaling

- **HTTP services** are stateless and scale horizontally; the order saga, idempotency keys, sessions and lockouts live in PostgreSQL.
- **Outbox relays** run in every replica. Claiming rows with `FOR UPDATE SKIP LOCKED` and a lease means replicas never publish the same row concurrently; after a crash the lease expires and another replica republishes, so consumers may see a message twice.
- **Consumers** on the same queue compete for messages (one replica handles each). Each handler records `(consumer, message_id)` in `processed_messages` inside its transaction, so redelivery and duplicates are harmless. Delivery order across replicas is not guaranteed; the handlers where it matters guard against it (e.g. product availability ignores older `occurredAt`, inventory/payment record tombstones when a cancel arrives before the create).
- **Worker scheduler** uses a Redis `SET NX PX` leader lock per task, so with several worker replicas each maintenance command is normally published once per interval; maintenance commands are delivered to one replica of the target service. If Redis is unavailable the lock fails open and commands may be published more than once; the maintenance tasks are written to be re-run safely.
- Scale on CPU for HTTP-heavy services (the Kubernetes example uses HPAs for gateway, product, inventory and order). For consumer-heavy services, queue depth is the better signal (e.g. KEDA with the RabbitMQ scaler) — not included here.
- Watch database connections when scaling (see pool sizing above).

## Zero downtime: what is and is not promised

The building blocks are in place: rolling updates that add a new instance before removing an old one, readiness probes that keep unready instances out of rotation, a short pre-stop delay for load balancers to notice, and in-app graceful shutdown that finishes in-flight HTTP requests and message handlers. Together they **reduce** disruption during deploys and scale-in. They do **not guarantee** that no request ever fails: clients can still see a reset connection on a long-lived keep-alive socket, requests that exceed the shutdown timeout are cut, upstream circuit breakers may open briefly, and broker or database failovers cause short error bursts. Clients should retry idempotent requests, and `POST /orders` requires an `Idempotency-Key` precisely so retries are safe.

Database migrations need the same care: old and new versions run side by side during a rollout, so every migration must be backward compatible (expand → deploy → contract in a later release). Run the migrator **before** rolling out the new version, and never run a destructive migration in the same release that stops using the column.

## Checklist before going live

- [ ] Real payment provider integration replaces the simulator.
- [ ] Secrets in a secret manager; local defaults removed; bootstrap admin password rotated.
- [ ] TLS at the edge; `COOKIE_SECURE=true`; CORS restricted.
- [ ] Separate migration and runtime database roles; TLS to PostgreSQL, RabbitMQ and Redis.
- [ ] PITR enabled and a restore drill performed.
- [ ] 3-node RabbitMQ (quorum queues) and alerting on queue depth and dead letters.
- [ ] Alerts and dashboards tuned to real traffic ([observability](../operations/observability.md)); runbook links reachable by on-call.
- [ ] Log retention and data retention reviewed ([data retention](../operations/data-retention.md)).
