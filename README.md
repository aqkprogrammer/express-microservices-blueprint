<div align="center">

# Express Microservices Blueprint

**A working, production-oriented reference architecture for Express.js and TypeScript microservices.**
It covers event-driven communication over RabbitMQ, a transactional outbox, an orchestrated saga with
compensation, per-service PostgreSQL databases, Redis caching, OpenTelemetry observability, Docker,
and CI/CD. Everything in it is tested end to end.

[![CI](https://github.com/aqkprogrammer/express-microservices-blueprint/actions/workflows/ci.yml/badge.svg)](https://github.com/aqkprogrammer/express-microservices-blueprint/actions/workflows/ci.yml)
[![Security](https://github.com/aqkprogrammer/express-microservices-blueprint/actions/workflows/security.yml/badge.svg)](https://github.com/aqkprogrammer/express-microservices-blueprint/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%E2%89%A522.13%20%7C%2024-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0%20strict-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![RabbitMQ](https://img.shields.io/badge/RabbitMQ-4.1-FF6600?logo=rabbitmq&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-traces%20%7C%20logs-425CC7?logo=opentelemetry&logoColor=white)

<img src="docs/assets/animated/system-overview.svg" alt="System overview: clients call the API gateway, which routes to nine Express services. Each service owns its PostgreSQL database and communicates through RabbitMQ, with Redis for caching and rate limits and Jaeger, Loki, Prometheus and Grafana for observability." width="900">

</div>

> **Status: reference implementation.** It runs locally with one command and is covered by unit,
> contract, integration, end-to-end and resilience tests. It is a starting point for learning and
> adaptation, not a turnkey production platform. Known limitations are listed in
> [Limitations](#limitations).

## Table of contents

1. [Goals and design principles](#goals-and-design-principles)
2. [Key features](#key-features)
3. [Technology stack](#technology-stack)
4. [Architecture overview](#architecture-overview)
5. [Animated flows](#animated-flows)
6. [Services and responsibilities](#services-and-responsibilities)
7. [Service communication](#service-communication)
8. [Database ownership](#database-ownership)
9. [RabbitMQ topology, retries and dead letters](#rabbitmq-topology-retries-and-dead-letters)
10. [Transactional outbox](#transactional-outbox)
11. [Order saga and compensation](#order-saga-and-compensation)
12. [API gateway and edge security](#api-gateway-and-edge-security)
13. [Redis caching strategy](#redis-caching-strategy)
14. [Authentication and authorization](#authentication-and-authorization)
15. [Observability](#observability)
16. [Repository structure](#repository-structure)
17. [Prerequisites](#prerequisites)
18. [Quick start](#quick-start)
19. [Configuration](#configuration)
20. [Docker commands](#docker-commands)
21. [Database migrations and seed data](#database-migrations-and-seed-data)
22. [API endpoints and examples](#api-endpoints-and-examples)
23. [Walkthrough: placing an order](#walkthrough-placing-an-order)
24. [Walkthrough: failure and recovery](#walkthrough-failure-and-recovery)
25. [Testing](#testing)
26. [Load testing](#load-testing)
27. [CI/CD](#cicd)
28. [Local development](#local-development)
29. [Production and Kubernetes](#production-and-kubernetes)
30. [Security considerations](#security-considerations)
31. [Performance considerations](#performance-considerations)
32. [Troubleshooting](#troubleshooting)
33. [Limitations](#limitations)
34. [Contributing](#contributing)
35. [Roadmap](#roadmap)
36. [License and attribution](#license-and-attribution)
37. [Documentation index](#documentation-index)

## Goals and design principles

- **Show the hard parts working**, not just the folder structure. Covered: reliable event
  publication, idempotent consumers, sagas with compensation, timeouts that don't guess, and
  observability that follows a request across HTTP and message boundaries.
- **Each service owns its data.** Every service has its own database and role, its own migrations,
  and no shared tables. Services read other services' data only through events or their APIs.
- **At-least-once delivery, idempotent processing.** The project never claims exactly-once delivery.
  Duplicates are expected and made harmless.
- **Fail safe and stay observable.** Timeouts, circuit breakers and bounded retries guard every
  outbound call. Dead letters are archived, never dropped. Errors are RFC 9457 problem documents
  that don't leak internals.
- **Essential complexity only.** Each tool has a stated reason. Optional pieces such as Kubernetes
  are clearly marked, and larger-scale alternatives such as Kafka are discussed in
  [ADRs](docs/decisions/README.md) instead of being deployed.
- **Twelve-factor configuration.** Configuration comes from validated environment variables, with
  `*_FILE` support for secrets. Logs go to stdout. Processes are disposable with graceful shutdown.

## Key features

| Area            | What is implemented                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business domain | Users, product catalog, inventory with reservations, orders with price snapshots, a payment **simulator**, email notifications, an audit trail                                                    |
| Reliability     | Transactional outbox in every producing service, publisher confirms, manual acks, delayed retry queues, dead-letter archive with replay, idempotent consumers, persisted saga state               |
| Consistency     | Orchestrated order saga with compensation; overselling prevention with conditional updates and CHECK constraints; payment-timeout reconciliation; tombstones for out-of-order events              |
| API             | Versioned REST (`/api/v1`), OpenAPI 3.1 for every service, aggregated Swagger UI, pagination, filtering and sorting, `Idempotency-Key` for critical writes, problem details                       |
| Security        | Argon2id, ES256 JWT with JWKS, refresh-token rotation with reuse detection, RBAC plus ownership checks, rate limits, body limits, Helmet, CORS allow-list, log redaction, non-root minimal images |
| Observability   | Structured Pino logs with correlation, causation and trace IDs; OpenTelemetry traces across HTTP, PostgreSQL, Redis and RabbitMQ; Prometheus metrics; Grafana dashboards; 12 example alerts       |
| Delivery        | One-command Docker Compose stack, migrator release step, GitHub Actions (CI, CodeQL, gitleaks, npm audit, Trivy, releases), Dependabot, optional Kustomize manifests                              |

## Technology stack

| Layer                | Choice                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime and language | Node.js 24 LTS (22.13+ supported), TypeScript 6 strict, ES modules, npm workspaces                       |
| HTTP                 | Express 5, Helmet, Zod validation, `@asteasolutions/zod-to-openapi`, Swagger UI                          |
| Data                 | PostgreSQL 17, Prisma 7 with the `pg` driver adapter (raw SQL for concurrency-critical updates), Redis 8 |
| Messaging            | RabbitMQ 4.1 (quorum queues, publisher confirms) via `amqplib` 2 with built-in connection recovery       |
| Auth                 | `argon2` (Argon2id), `jose` (ES256 JWT, JWKS)                                                            |
| Observability        | Pino, OpenTelemetry SDK, Jaeger v2, Loki, Prometheus (`prom-client`), Grafana                            |
| Testing              | Vitest, Supertest, Testcontainers, k6                                                                    |
| Tooling              | ESLint (typescript-eslint strict, type-checked), Prettier, Docker multi-stage builds, GitHub Actions     |

## Architecture overview

```mermaid
flowchart LR
    client([Client]) -->|HTTPS| gw[api-gateway]
    gw --> auth[auth-service]
    gw --> users[user-service]
    gw --> product[product-service]
    gw --> inventory[inventory-service]
    gw --> order[order-service]
    gw --> payment[payment-service]
    gw --> notification[notification-service]
    gw --> audit[audit-service]
    order -. "price snapshot (internal HTTP)" .-> product
    order -. "payment reconciliation (internal HTTP)" .-> payment
    subgraph bus[RabbitMQ]
      events{{domain.events}}
      maint{{maintenance.commands}}
      dlx{{dead-letters}}
    end
    auth & users & product & inventory & order & payment & notification -- outbox --> events
    events --> users & auth & product & inventory & order & payment & notification & audit
    worker[worker] -- schedules --> maint
    dlx --> worker
    product <--> redis[(Redis)]
    gw <--> redis
```

Each service owns a PostgreSQL database that no other service touches. The full set of diagrams
(request lifecycle, event flow, saga, outbox, retries, auth, observability, Compose, Kubernetes,
CI/CD, failure recovery) is in [docs/architecture](docs/architecture/README.md).

## Animated flows

The SVGs below are animated with CSS only: no scripts and no external resources. Each one has a
static Mermaid equivalent, and they show every step at once when your system asks for reduced
motion. Regenerate them with `npm run diagrams:build`.

| Order saga (success)                                                                                                        | Order saga (payment declined → compensation)                                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [![Order saga success flow](docs/assets/animated/order-saga-success.svg)](docs/architecture/04-order-saga.md)               | [![Order saga compensation flow](docs/assets/animated/order-saga-compensation.svg)](docs/architecture/04-order-saga.md) |
| **Transactional outbox**                                                                                                    | **Retry and dead-letter flow**                                                                                          |
| [![Transactional outbox flow](docs/assets/animated/transactional-outbox.svg)](docs/architecture/05-transactional-outbox.md) | [![Retry and dead-letter flow](docs/assets/animated/retry-dead-letter.svg)](docs/architecture/06-retry-dead-letter.md)  |
| **Request lifecycle**                                                                                                       | **Broker outage and recovery**                                                                                          |
| [![Request lifecycle](docs/assets/animated/request-lifecycle.svg)](docs/architecture/02-request-lifecycle.md)               | [![Failure recovery](docs/assets/animated/failure-recovery.svg)](docs/architecture/12-failure-recovery.md)              |

Also available: [refresh-token rotation and reuse detection](docs/assets/animated/auth-refresh-rotation.svg).

## Services and responsibilities

| Service                                           | Port | Owns                         | Responsibilities                                                                                                                                     |
| ------------------------------------------------- | ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [api-gateway](apps/api-gateway)                   | 8080 | –                            | Routing, request and correlation IDs, rate limits, body limits, timeouts, per-upstream circuit breakers, aggregated API docs. **No business logic.** |
| [auth-service](apps/auth-service)                 | 3001 | `auth_db`                    | Registration, login, Argon2id, ES256 access tokens and JWKS, refresh rotation, logout, password reset, lockout, account-status enforcement           |
| [user-service](apps/user-service)                 | 3002 | `users_db`                   | Profiles (created from `UserRegistered`), profile updates, admin search and filters, account status lifecycle                                        |
| [product-service](apps/product-service)           | 3003 | `product_db` (+ Redis cache) | Catalog CRUD for admins, public listing, search, filters, sorting, pagination, availability read model, cache-aside                                  |
| [inventory-service](apps/inventory-service)       | 3004 | `inventory_db`               | Stock levels, reservations with TTL, commit, release and restock, audited adjustments, overselling protection                                        |
| [order-service](apps/order-service)               | 3005 | `orders_db`                  | Idempotent order creation, price snapshots, status history, cancellation, **saga orchestrator**                                                      |
| [payment-service](apps/payment-service)           | 3006 | `payment_db`                 | **Local payment simulator**: authorize, capture, void and refund; idempotency keys; reconciliation of unknown outcomes                               |
| [notification-service](apps/notification-service) | 3007 | `notification_db`            | Email templates (versioned and editable), recipient read model, delivery status, retries and DLQ, SMTP or console transport                          |
| [audit-service](apps/audit-service)               | 3008 | `audit_db`                   | Append-only audit trail with allow-listed fields, admin-only search, retention                                                                       |
| [worker](apps/worker)                             | 3009 | `worker_db`                  | Leader-elected maintenance scheduler; dead-letter archive with replay and discard; job history                                                       |

Shared code lives in small packages with one job each: [`config`](packages/config),
[`logger`](packages/logger), [`observability`](packages/observability), [`http-kit`](packages/http-kit),
[`security`](packages/security), [`contracts`](packages/contracts), [`database`](packages/database),
[`messaging`](packages/messaging) and [`testing`](packages/testing).

## Service communication

- **Synchronous HTTP** is used only where an immediate answer is required:
  - the gateway calls the services;
  - `order-service` fetches **authoritative prices** from `product-service`;
  - `order-service` **reconciles payments** with `payment-service` after a timeout.

  Calls go through `ServiceClient` ([http-kit](packages/http-kit/src/http-client.ts)), which adds:
  per-call timeouts; bounded retries for idempotent requests only (a `POST` is never retried
  blindly); a circuit breaker; correlation-ID propagation; Zod-validated responses; and an SSRF
  guard (relative paths, fixed origin, no redirects). Internal endpoints live under `/internal/*`,
  require a service token, and are **never routed by the gateway**.

- **Asynchronous events** carry everything else. Events use a common envelope (`id`, `type`,
  `version`, `occurredAt`, `producer`, `correlationId`, `causationId`, `subject`, `payload`) that is
  validated by Zod schemas on both the producing and the consuming side. The catalog of 31 versioned
  events is in [docs/development/event-catalog.md](docs/development/event-catalog.md).

## Database ownership

- One PostgreSQL instance runs locally, but each service gets **its own database and login role**.
  `CONNECT` is revoked from `PUBLIC`, so a service cannot even connect to another service's
  database ([init script](infrastructure/postgres/init/01-create-service-databases.sh)).
- Each service has its **own Prisma schema and migration history** under `apps/<service>/prisma`.
  There is no shared schema. CHECK constraints that Prisma can't express (stock invariants, status
  enums, money ≥ 0, simulated-token format) live in the migrations.
- A one-shot **migrator** image is the release step. It runs `prisma migrate deploy` for each
  service, loads the idempotent demo seed, and declares the RabbitMQ topology. Runtime images contain
  no migration tooling.
- Backup and restore are covered in [docs/operations/backup-restore.md](docs/operations/backup-restore.md);
  retention in [docs/operations/data-retention.md](docs/operations/data-retention.md).

## RabbitMQ topology, retries and dead letters

| Element                    | Details                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exchanges (topic, durable) | `domain.events` (all domain events), `maintenance.commands` (scheduled tasks), `dead-letters`                                                      |
| Routing keys               | `<domain>.<event>.v<version>`, e.g. `order.created.v1`, `inventory.reservation-failed.v1`, `payment.authorized.v1`                                 |
| Consumer queues            | One **quorum** queue per service (`order-service.events`, …) with `x-delivery-limit` 10 and the dead-letter exchange set                           |
| Retry tiers                | `<queue>.retry.1..3` classic queues with TTL 1 s / 5 s / 15 s (notifications 2 s / 10 s / 30 s) that dead-letter back to the main queue            |
| Poison messages            | An invalid envelope or payload, or an unknown type, goes straight to `dead-letters`, with the reason in headers                                    |
| Exhaustion                 | After the last retry the message is published to `dead-letters` with diagnostics, then acked                                                       |
| Archive                    | `worker.dead-letters` receives every dead letter. The worker stores it in Postgres; admins list, replay (to the original queue only) or discard it |
| Never silently lost        | A message is acked only after its outcome is durably handed off. If even the republish fails, the message is nacked and requeued                   |

The single source of truth is [packages/contracts/src/topology.ts](packages/contracts/src/topology.ts).
An import-ready [definitions.json](infrastructure/rabbitmq/definitions.json) is generated from it
with `npm run topology:generate`, and a contract test keeps the two in sync.

## Transactional outbox

1. The business change and an `outbox_events` row commit **in the same transaction**
   (`enqueueEvent(tx, …)`). The payload is validated against the event contract first, and the
   current trace context is stored with it.
2. An in-process `OutboxRelay` claims rows with
   `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` and a 30 s lease, so several replicas
   share the work without double-claiming.
3. A row is marked `PUBLISHED` only after a **broker confirm**. A failure puts it back to `PENDING`
   with an attempt count, the last error, and exponential backoff. Rows are never dropped, and the
   `outbox_oldest_pending_age_seconds` metric and an alert make a stall visible.
4. A crash between the confirm and the status update causes a duplicate, which idempotent consumers
   absorb (`processed_messages` is written in the handler's transaction).

Details and trade-offs (ordering, retention, polling) are in [ADR 0009](docs/decisions/0009-transactional-outbox.md).

## Order saga and compensation

`order-service` **orchestrates** the saga. Its state lives in `order_sagas`, so a restarted process
resumes where it left off (see [ADR 0010](docs/decisions/0010-saga-orchestration-and-compensation.md)):

```mermaid
sequenceDiagram
    participant C as Client
    participant O as order-service
    participant I as inventory-service
    participant P as payment-service (simulator)
    participant N as notification-service
    C->>O: POST /api/v1/orders (Idempotency-Key)
    O-->>C: 201 PENDING
    O->>I: OrderCreated (outbox)
    I->>O: InventoryReserved | InventoryReservationFailed
    O->>P: PaymentAuthorizationRequested
    P->>O: PaymentAuthorized | PaymentFailed
    alt success
        O->>I: OrderConfirmed → stock committed
        O->>P: OrderConfirmed → payment captured
        O->>N: OrderConfirmed → confirmation email
    else failure
        O->>I: OrderCancelled → reservation released
        O->>P: OrderCancelled → void / refund if needed
        O->>N: OrderCancelled → cancellation email
    end
```

- **Statuses:** `PENDING → AWAITING_PAYMENT → CONFIRMED`, plus `CANCELLED` and `REQUIRES_REVIEW`.
  An explicit transition table makes duplicate and late events harmless.
- **Timeouts:**
  - With no inventory answer, the order is cancelled. Inventory releases the stock, or skips it via
    a tombstone if the cancellation arrives first.
  - With no payment answer, the saga **does not assume failure**. It asks `payment-service` for the
    real outcome: it confirms or cancels if the outcome is known, re-requests authorization (which is
    idempotent per order) while it is unknown, and escalates to `REQUIRES_REVIEW` after three
    attempts.
- **Compensations** are idempotent and order-tolerant: release or restock stock, void an
  authorization, refund a capture.

## API gateway and edge security

The gateway uses its own streaming reverse proxy over `fetch`. It routes the public surface listed in
[routes.ts](apps/api-gateway/src/routes.ts) and nothing else. It:

- normalizes paths and rejects `..` and encoded separators;
- strips client-supplied `x-internal-token` and forwarding headers;
- enforces a 256 KB body limit and per-IP rate limits (300 requests/min overall, 20/min on
  credential endpoints) stored in Redis;
- applies Helmet security headers, CORS for allow-listed origins only, and a 10 s upstream timeout;
- runs a circuit breaker per upstream;
- returns problem-details errors (`502`, `503` or `504` for upstream failures).

Its Prometheus metrics are served on a separate, non-public port.

## Redis caching strategy

Redis is **never the system of record** ([ADR 0007](docs/decisions/0007-redis-not-system-of-record.md)).

| Use                   | Behaviour                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product cache-aside   | Detail TTL 300 s, list TTL 60 s, ±10% jitter; detail keys deleted on change, list pages invalidated by a generation counter                                                       |
| Stampede protection   | In-process single-flight, plus a short `SET NX PX` lock across instances                                                                                                          |
| Gateway rate limits   | Shared counters so limits hold across gateway replicas                                                                                                                            |
| Scheduler leader lock | One worker replica publishes each maintenance tick                                                                                                                                |
| Outage behaviour      | **Fail open**: a 250 ms command timeout and no offline queue. The cache is bypassed for Postgres; rate limits pass; the scheduler publishes without a lock (tasks are idempotent) |

## Authentication and authorization

- **Access tokens:** ES256 JWTs (`typ: at+jwt`) valid for 15 minutes, carrying `sub`, `roles`, `sid`
  and `jti`. Every service verifies them against the auth service's JWKS.
- **Refresh tokens:** opaque 256-bit tokens, stored only as SHA-256 hashes and rotated on every use.
  **Replaying a rotated token revokes the whole session.** For browsers they are also set as an
  `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/auth`.
- **Passwords:**
  - hashed with Argon2id;
  - unknown and wrong emails produce identical errors with similar timing;
  - lockout after 5 failures;
  - single-use, 15-minute reset links that always return `202` and revoke all sessions when used.
- **Authorization:**
  - role checks for `customer` and `admin`;
  - resource ownership checks: other customers' orders and payments return `404`;
  - suspending an account revokes its sessions through `UserStatusChanged`.
- The **limitations of a reference implementation**, and when to use an identity provider instead,
  are in [docs/security/authentication.md](docs/security/authentication.md).

## Observability

- **Logs:**
  - Pino JSON with `service`, `env`, `requestId`, `correlationId`, `causationId`, `userId`,
    `traceId`, `spanId`, an error class and duration;
  - secrets and credentials are redacted;
  - shipped to Loki over OTLP.
- **Traces:**
  - the OpenTelemetry SDK is preloaded with `node --import`, together with the ESM loader hook;
  - instrumented: HTTP, Express, fetch, PostgreSQL, ioredis and Pino;
  - trace context is propagated in AMQP headers **and stored on outbox rows**, so one trace spans the
    gateway, the services, RabbitMQ consumers and follow-up events (verified: one order produced a
    single trace across 8 services);
  - viewed in Jaeger, and linked to logs in Grafana.
- **Metrics:**
  - RED metrics per route template;
  - messaging (consumed by outcome, retries, dead letters, queue depth from RabbitMQ);
  - outbox backlog, saga outcomes and duration, cache hits and misses, DB pool usage, and job runs;
  - labels are bounded: never user IDs or order IDs.
- **Dashboards and alerts:**
  - [Grafana dashboards](infrastructure/grafana/dashboards);
  - [example alert rules](infrastructure/prometheus/alerts.yml) that link to the
    [runbook](docs/operations/runbook.md). They are examples and need tuning before production use.

## Repository structure

```text
express-microservices-blueprint/
├── apps/                     # Deployable services (each: src/, prisma/ migrations, tests)
│   ├── api-gateway/  auth-service/  user-service/  product-service/  inventory-service/
│   └── order-service/  payment-service/  notification-service/  audit-service/  worker/
├── packages/                 # Shared libraries (no business logic)
│   ├── config/  logger/  observability/  http-kit/  security/
│   └── contracts/  database/  messaging/  testing/
├── infrastructure/
│   ├── docker/               # Multi-stage Dockerfile (runtime + migrator targets), migrate.sh
│   ├── postgres/  rabbitmq/  prometheus/  grafana/  loki/  tracing/
│   └── kubernetes/           # Optional Kustomize base + overlays
├── tests/
│   ├── contract/  integration/  e2e/  resilience/  load/  support/
├── docs/                     # Architecture, ADRs, API, operations, security, deployment, …
├── scripts/                  # Dev runner, docs/OpenAPI validation, generators, k6 runner
├── .github/                  # CI, security and release workflows, templates, Dependabot
├── docker-compose.yml        # Complete local environment
└── docker-compose.dev.yml    # Publishes infrastructure ports for running services from source
```

## Prerequisites

- Docker Engine 24+ with the Compose v2 plugin, and **about 6 GB of RAM** available to Docker. The
  full stack runs 18 containers with memory limits.
- Node.js 22.13+ (24 recommended, see `.nvmrc`) and npm 10+, for development and tests only.
- Free local ports: 8080, 3000, 3009, 8025, 9090, 15672 and 16686, all bound to `127.0.0.1`.

## Quick start

```bash
git clone https://github.com/aqkprogrammer/express-microservices-blueprint.git
cd express-microservices-blueprint
docker compose up --build
```

On the first run, the images build and `keygen` and `migrator` complete before the services start.
Once every service reports healthy:

| URL                                   | What                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| http://localhost:8080/docs            | Swagger UI for every service (through the gateway)          |
| http://localhost:8080/api/v1/products | Public catalog                                              |
| http://localhost:8025                 | Mailpit: every email the system sends                       |
| http://localhost:16686                | Jaeger: distributed traces                                  |
| http://localhost:3000                 | Grafana (`admin` / `local-dev-grafana-password`)            |
| http://localhost:9090                 | Prometheus (targets, alerts)                                |
| http://localhost:15672                | RabbitMQ management (`emb` / `local-dev-rabbitmq-password`) |

The seed creates 8 products and an administrator, `admin@example.test` / `local-dev-admin-password`.
**All of these defaults are synthetic and for local use only.**

## Configuration

Every service validates its environment at startup with Zod and refuses to start if it is
misconfigured. Error messages name the variable but never echo its value. Any variable can be
supplied as a file with `<NAME>_FILE` (Docker and Kubernetes secrets).

- `docker-compose.yml` contains safe local defaults; override them with a `.env` file (copy
  [.env.example](.env.example)).
- The per-service variables are listed in
  [docs/development/getting-started.md](docs/development/getting-started.md).
- `.env`, keys (`*.pem`), `secrets/` and database dumps are git-ignored.

## Docker commands

```bash
docker compose up --build -d --wait     # start everything in the background (npm run docker:up)
docker compose ps                       # health of every container
docker compose logs -f order-service    # follow one service (npm run docker:logs for all)
docker compose restart payment-service  # restart one service
docker compose down                     # stop and remove containers, KEEP data (npm run docker:down)
```

> ⚠️ **`docker compose down --volumes` permanently deletes all local data** (databases, broker
> state, metrics, the JWT signing key). Only use it when you want a clean slate.

## Database migrations and seed data

```bash
docker compose run --rm migrator                      # apply all migrations + seed + declare topology (idempotent)
docker compose run --rm -e RUN_SEED=false migrator    # migrations and topology only

# From the host, one service at a time (each service has its own database URL):
DATABASE_URL=postgresql://orders_svc:local-dev-order-db-password@localhost:5432/orders_db \
  npm run prisma:migrate -w @emb/order-service
DATABASE_URL=postgresql://product_svc:local-dev-product-db-password@localhost:5432/product_db \
  npm run db:seed -w @emb/product-service             # after npm run build
```

Host access needs the published ports from `docker-compose.dev.yml`. The root `npm run db:migrate`
and `npm run db:seed` run the same scripts in every workspace, which is useful in CI when
`DATABASE_URL` is set per job.

Add a migration by editing a service's `prisma/schema.prisma` and running
`npx prisma migrate dev --name <change>` in that service's directory against a development database.
Existing migrations are never edited.

## API endpoints and examples

| Area          | Endpoints (all under `http://localhost:8080`)                                                                                                                  | Access                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Auth          | `POST /api/v1/auth/{register,login,refresh,logout}`, `POST /api/v1/auth/password-reset/{request,confirm}`, `GET /api/v1/auth/me`, `GET /.well-known/jwks.json` | Public / token         |
| Products      | `GET /api/v1/products`, `GET /api/v1/products/{id}`; `POST`, `PATCH` for admins                                                                                | Public / admin         |
| Orders        | `POST /api/v1/orders` (Idempotency-Key), `GET /api/v1/orders[/{id}[/history]]`, `POST /api/v1/orders/{id}/cancel`                                              | Customer (own) / admin |
| Payments      | `GET /api/v1/payments?orderId=`, `GET /api/v1/payments/{id}`; `POST /intents`, `/{id}/capture`, `/{id}/refund` for admins                                      | Customer (own) / admin |
| Users         | `GET`/`PATCH /api/v1/users/me`; `GET /api/v1/users`, `PATCH /api/v1/users/{id}/status` for admins                                                              | Customer / admin       |
| Inventory     | `GET /api/v1/inventory`, `POST /api/v1/inventory/{id}/adjustments`, `GET /api/v1/inventory/reservations/{orderId}`                                             | Admin                  |
| Notifications | `GET /api/v1/notifications`; `GET`/`PUT /api/v1/notifications/templates[/{key}]`                                                                               | Customer (own) / admin |
| Audit         | `GET /api/v1/audit-events`                                                                                                                                     | Admin                  |

The full classification (public, authenticated, admin, internal), more `curl` examples, pagination
and idempotency rules are in [docs/api/README.md](docs/api/README.md). Error codes are listed in
[docs/api/errors.md](docs/api/errors.md). Exported OpenAPI files are in [docs/api/openapi](docs/api/openapi).

## Walkthrough: placing an order

Requires `curl` and `jq`.

```bash
API=http://localhost:8080

# 1. Register (returns an access token and a rotating refresh token)
TOKEN=$(curl -s -X POST $API/api/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple","displayName":"Ada"}' | jq -r .accessToken)

# 2. Browse the catalog (anonymous, served from the Redis cache after the first call)
curl -s "$API/api/v1/products?sort=price&pageSize=3" | jq '.data[] | {id, sku, price, availability}'

# 3. Place an order (retrying with the same Idempotency-Key returns the same order)
ORDER=$(curl -s -X POST $API/api/v1/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"lines":[{"productId":"0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001","quantity":2}],"paymentMethodToken":"sim_card_approved"}' | jq -r .id)

# 4. Watch the saga: PENDING → AWAITING_PAYMENT → CONFIRMED (usually within a second or two)
curl -s $API/api/v1/orders/$ORDER -H "authorization: Bearer $TOKEN" | jq '{status, saga}'
curl -s $API/api/v1/orders/$ORDER/history -H "authorization: Bearer $TOKEN" | jq
```

Then open Mailpit (http://localhost:8025) to see the confirmation email, and Jaeger
(http://localhost:16686, service `api-gateway`) to see the whole saga as one trace.

## Walkthrough: failure and recovery

The payment simulator chooses its behaviour from the `paymentMethodToken`. It never sees card data.

| Token                    | What happens                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sim_card_approved`      | Authorized, then captured after confirmation                                                                                                               |
| `sim_card_declined`      | `PaymentFailed`; the order is `CANCELLED (payment_failed)`, the reservation is released, and a cancellation email is sent                                  |
| `sim_insufficient_funds` | Same as declined, with the reason `insufficient_funds`                                                                                                     |
| `sim_transient_error`    | The provider fails twice; the message goes through the **retry queues** and the order is confirmed on the third attempt                                    |
| `sim_provider_timeout`   | The outcome is unknown; the order **stays AWAITING_PAYMENT** until reconciliation finds the authorization succeeded (about 20–45 s locally), then confirms |

More scenarios to try:

```bash
# Out of stock: the limited lamp has 1 unit
#   → CANCELLED (out_of_stock), nothing charged

# Broker outage: orders are still accepted, kept in the outbox, then completed
docker compose stop rabbitmq   # place an order now → it stays PENDING
docker compose start rabbitmq  # → it is published and confirmed

# Failing email: register with an address at bounce.test
#   → 4 delivery attempts → dead letter archived by the worker
curl -s localhost:3009/admin/v1/dead-letters -H "authorization: Bearer $ADMIN_TOKEN" | jq '.data[] | {id, originalQueue, reason}'
```

The resilience test suite automates all of these, plus PostgreSQL and Redis outages, restarts,
duplicate and malformed messages, and delayed compensation. See the
[runbook](docs/operations/runbook.md) for operator procedures.

## Testing

| Command                    | What it runs                                                                                                                             | Needs               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `npm run test:unit`        | Domain rules, state machines, HTTP kit, security, messaging helpers (`apps/*/src`, `packages/*/src`)                                     | Node only           |
| `npm run test:contract`    | Frozen v1 event fixtures, producer/consumer topology checks scanned from source, OpenAPI validity and gateway exposure, definitions sync | Node only           |
| `npm run test:integration` | Real PostgreSQL, RabbitMQ and Redis via Testcontainers: outbox, retries and DLQ, overselling, saga, auth, cache                          | Docker              |
| `npm run test:e2e`         | Full workflows through the gateway (sagas, compensation, idempotency, auth flows, RBAC, emails)                                          | `docker compose up` |
| `npm run test:resilience`  | Stops and starts containers: broker, DB and Redis outages, restarts, duplicates, poison messages, DLQ replay                             | `docker compose up` |
| `npm test`                 | Unit and contract tests                                                                                                                  | Node only           |
| `npm run test:coverage`    | Unit tests with V8 coverage                                                                                                              | Node only           |

Results from the latest local run (2026-10-16, before publishing) are in the
[testing guide](docs/development/testing.md#latest-recorded-run). CI runs every suite on each pull
request.

## Load testing

k6 scenarios live in [tests/load](tests/load) and run in Docker against the Compose stack:

```bash
RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=1000 docker compose up -d --wait api-gateway  # one IP generates all traffic
npm run test:load                          # catalog browsing (list, search, detail)
npm run test:load -- order-placement.js    # authenticated order placement
docker compose up -d --wait api-gateway    # restore default limits
```

Measured numbers, the environment, and what they do and don't mean are in
[docs/operations/performance.md](docs/operations/performance.md). They are not capacity claims.

## CI/CD

| Workflow                                   | Jobs                                                                                                                                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CI](.github/workflows/ci.yml)             | Format, lint, typecheck, unit tests (coverage), contract tests, docs and OpenAPI validation, generated-artefact drift → Node 22/24 matrix → integration (Testcontainers) → image build + Trivy → e2e + resilience on Compose |
| [Security](.github/workflows/security.yml) | CodeQL (security-and-quality), `npm audit`, gitleaks over full history, dependency review on PRs; also weekly                                                                                                                |
| [Release](.github/workflows/release.yml)   | On `v*.*.*` tags: verify, then create a GitHub release from the CHANGELOG. Images are pushed to GHCR **only** if the `PUBLISH_IMAGES` variable is `true`                                                                     |
| [Dependabot](.github/dependabot.yml)       | Weekly npm (grouped), GitHub Actions and Docker base-image updates                                                                                                                                                           |

Workflows use least-privilege `permissions`, and third-party actions are pinned to commit SHAs.
Nothing is deployed automatically. See [docs/architecture/11-ci-cd.md](docs/architecture/11-ci-cd.md).

## Local development

```bash
npm ci
npm run build                      # Prisma clients + TypeScript project references
npm run dev -- order-service       # infrastructure in Docker, the service from source with hot reload
npm run dev -- all                 # every service from source
npm run lint && npm run typecheck && npm run format:check
```

`npm run dev` starts the infrastructure with [docker-compose.dev.yml](docker-compose.dev.yml), which
publishes Postgres, Redis and RabbitMQ on `127.0.0.1`. It then runs the migrator, generates a local
signing key, and starts the services with `tsx watch`. See
[docs/development/getting-started.md](docs/development/getting-started.md) and
[adding a service](docs/development/adding-a-service.md).

## Production and Kubernetes

Kubernetes is **optional**. The recommended path is Docker Compose for development, then managed
containers, then Kubernetes once its operational cost is justified
([ADR 0013](docs/decisions/0013-when-kubernetes-becomes-worthwhile.md)).

- [infrastructure/kubernetes](infrastructure/kubernetes) holds a Kustomize base with `local` and
  `production-example` overlays. It includes:
  - Deployments with restricted security contexts and probes;
  - Services, HPAs, PDBs, default-deny NetworkPolicies, Ingress to the gateway only, and a migration
    Job;
  - secret references only; the example secrets are placeholders.
- The manifests render, pass `kubeconform`, and pass server-side dry-run admission (including Pod
  Security "restricted"). **They have not been run on a live cluster in this project's own testing.**
  See [docs/deployment/kubernetes.md](docs/deployment/kubernetes.md).
- Production concerns are covered in [docs/deployment/production.md](docs/deployment/production.md):
  TLS, secret management, separating the migration and runtime DB roles, backups and PITR, RabbitMQ
  clustering, scaling, and honest notes on zero-downtime deploys.

## Security considerations

- **Implemented:**
  - validation on every input and whitelisted output shaping;
  - RBAC plus ownership checks;
  - rate and body limits, Helmet, and a CORS allow-list;
  - secure cookie flags and log redaction;
  - problem details without stack traces;
  - least-privilege DB roles;
  - non-root images with no npm, Prisma CLI or shell tooling beyond Alpine's base;
  - `*_FILE` secrets;
  - an SSRF-guarded internal HTTP client;
  - CodeQL, npm audit, gitleaks and Trivy in CI.
- **Not claimed:** that the system is fully secure, or PCI DSS compliance. The payment service is a
  simulator.
- Read [docs/security/README.md](docs/security/README.md), the
  [threat model](docs/security/threat-model.md), and [SECURITY.md](SECURITY.md) for responsible
  disclosure.

## Performance considerations

- On small CPU budgets, tracing at 100% sampling dominates latency. Sample in production. The local
  stack keeps 100% sampling so every demo request is traceable
  ([measurements](docs/operations/performance.md)).
- The saga is asynchronous: the order API stays fast while consumers work through bursts. Scale
  consumers with replicas and prefetch; outbox relays and consumers are safe with multiple replicas.
- Product reads are cached, and catalog search uses `pg_trgm` indexes. Every list endpoint is
  paginated, with a stable sort order.

## Troubleshooting

| Symptom                                              | Fix                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `port is already allocated`                          | Stop the other process, or change the published port in `docker-compose.yml`                                                         |
| Image pulls fail with `429 Too Many Requests`        | Log in to Docker Hub or configure a registry mirror                                                                                  |
| Build fails with TLS errors behind a corporate proxy | `EXTRA_CA_FILE=/path/to/ca.pem docker compose build`: an optional build secret that is never stored in an image                      |
| A service is `unhealthy` or keeps restarting         | `docker compose logs <service>`. Configuration errors name the missing variable                                                      |
| `401` after recreating volumes                       | The signing key changed; log in again                                                                                                |
| `429` from the gateway                               | Per-IP limits (20/min on login and register); raise `AUTH_RATE_LIMIT_MAX` for local test runs                                        |
| Order stuck in `AWAITING_PAYMENT`                    | Expected for `sim_provider_timeout` until reconciliation (about 20–45 s); otherwise check `payment-service` and the worker scheduler |

More in [docs/troubleshooting](docs/troubleshooting/README.md).

## Limitations

- **Payment:** a local simulator only. There is no real provider integration, and webhook
  verification is designed and documented but not implemented.
- **Authentication:**
  - a reference implementation; prefer an established identity provider in production;
  - access tokens remain valid until they expire (at most 15 minutes) after logout, because there is
    no deny-list;
  - there is no email verification or MFA.
- **Consistency:**
  - event ordering is not guaranteed across concurrent outbox relays; consumers rely on state guards;
  - there is no admin "force confirm" for orders in `REQUIRES_REVIEW` (they can be cancelled);
  - a few events (`InventoryReleased`, `InventoryCommitted`, `NotificationSent`) are published for
    observability, and only the audit trail consumes some of them.
- **Operations:**
  - local observability storage is ephemeral or short-retention, and there is no Alertmanager
    routing;
  - the Kubernetes manifests have been validated but not run on a live cluster here;
  - load-test numbers come from one small machine.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md), and use the issue and PR templates. Please report
vulnerabilities privately ([SECURITY.md](SECURITY.md)).

## Roadmap

Ideas that would extend the blueprint without changing its principles:

- An OpenTelemetry Collector with tail sampling, and Alertmanager routing
- A real payment provider adapter with signed-webhook verification, kept behind the simulator interface
- An admin "resolve review" action for orders in `REQUIRES_REVIEW`
- Email verification and an optional TOTP second factor
- Per-aggregate ordered outbox publishing for consumers that need ordering
- A Helm chart alongside the Kustomize manifests
- Testing the Kubernetes manifests on kind in CI

## License and attribution

[MIT](LICENSE) © The express-microservices-blueprint contributors.

Built with Express, Prisma, RabbitMQ, PostgreSQL, Redis, OpenTelemetry, Jaeger, Grafana Loki,
Prometheus and Grafana, all used under their respective licenses.

## Documentation index

| Topic                                                                                                                                                                           | Highlights                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [Architecture](docs/architecture/README.md)                                                                                                                                     | 12 diagrams (Mermaid) with animated SVG flows                        |
| [Decisions (ADRs)](docs/decisions/README.md)                                                                                                                                    | 15 records with alternatives, trade-offs and operational cost        |
| [API](docs/api/README.md) · [Errors](docs/api/errors.md)                                                                                                                        | Endpoint classification, examples, RFC 9457 error catalogue          |
| [Event catalog](docs/development/event-catalog.md)                                                                                                                              | All 31 events, routing keys, producers, consumers, versioning policy |
| [Getting started](docs/development/getting-started.md) · [Testing](docs/development/testing.md)                                                                                 | Environment variables, dev workflow, test layers                     |
| [Operations runbook](docs/operations/runbook.md)                                                                                                                                | Alert-by-alert diagnosis and remediation                             |
| [Observability](docs/operations/observability.md) · [Performance](docs/operations/performance.md)                                                                               | Logs, metrics, traces; measured load-test results                    |
| [Backup & restore](docs/operations/backup-restore.md) · [Data retention](docs/operations/data-retention.md)                                                                     | Data lifecycle                                                       |
| [Security](docs/security/README.md) · [Authentication](docs/security/authentication.md) · [Payments](docs/security/payments.md) · [Threat model](docs/security/threat-model.md) | Security model and limitations                                       |
| [Kubernetes](docs/deployment/kubernetes.md) · [Production](docs/deployment/production.md)                                                                                       | Optional deployment paths                                            |
| [Troubleshooting](docs/troubleshooting/README.md)                                                                                                                               | Common errors and fixes                                              |
