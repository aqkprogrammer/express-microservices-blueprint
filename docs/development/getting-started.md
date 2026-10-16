# Getting started

## Prerequisites

| Tool              | Version                                       | Notes                                                                                        |
| ----------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Node.js           | 22.13+ or 24 (`.nvmrc` pins 24)               | Only needed to run tests or services from source                                             |
| npm               | 10+                                           | Workspaces                                                                                   |
| Docker Engine     | 24+ with Docker Compose v2 (`docker compose`) | BuildKit is used for image builds                                                            |
| Memory for Docker | about 6 GB                                    | Ten application containers, PostgreSQL, RabbitMQ, Redis, Mailpit and the observability stack |
| `curl`, `jq`      | any                                           | Used in the examples                                                                         |

## Quick start (everything in Docker)

```sh
git clone <repository-url> express-microservices-blueprint
cd express-microservices-blueprint
cp .env.example .env          # optional: the Compose file has synthetic local defaults
docker compose up --build     # or: npm run docker:up  (detached, waits for health checks)
```

The first build compiles every workspace and can take several minutes. Start-up order is enforced: PostgreSQL and RabbitMQ become healthy → `keygen` creates a development JWT key → `migrator` applies every service's migrations, seeds demo data and declares the RabbitMQ topology → services start → the gateway starts once all services are healthy.

| URL                                           | What                                                        |
| --------------------------------------------- | ----------------------------------------------------------- |
| <http://localhost:8080>                       | API gateway                                                 |
| <http://localhost:8080/docs>                  | Swagger UI for all services                                 |
| <http://localhost:8025>                       | Mailpit (emails)                                            |
| <http://localhost:15672>                      | RabbitMQ management (`emb` / `local-dev-rabbitmq-password`) |
| <http://localhost:3000>                       | Grafana (`admin` / `local-dev-grafana-password`)            |
| <http://localhost:16686>                      | Jaeger                                                      |
| <http://localhost:9090>                       | Prometheus                                                  |
| <http://127.0.0.1:3009/admin/v1/dead-letters> | Worker dead-letter admin API (admin token)                  |

All ports are bound to `127.0.0.1`. PostgreSQL, RabbitMQ (AMQP) and Redis are **not** published.

### Smoke test

```sh
# Public catalog (8 seeded products)
curl -s 'http://localhost:8080/api/v1/products?pageSize=3' | jq '.data[] | {id, sku, price, availability}'

# Register a customer and keep the access token
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.test","password":"correct-horse-battery","displayName":"Alice"}' | jq -r .accessToken)

# Place an order (Idempotency-Key is required)
ORDER=$(curl -s -X POST http://localhost:8080/api/v1/orders \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"lines":[{"productId":"0b6f7c1e-5d0a-4c39-9a43-0f8a0c1b2001","quantity":1}]}' | jq -r .id)

# The saga runs asynchronously: the order starts PENDING and is usually CONFIRMED within seconds
sleep 2; curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/orders/$ORDER | jq '{status, totalCents, saga}'
```

Then open Mailpit for the welcome and order-confirmation emails, and Jaeger to see the trace across services. More scenarios (declined payments, timeouts, failing email delivery) are in the [API guide](../api/README.md#trying-failure-scenarios).

Stop with `docker compose down` (keeps data). `docker compose down --volumes` **deletes all local data**, including the JWT signing key.

## Running services from source

Use this when you want hot reload, a debugger, or faster iteration on one service.

1. Install dependencies once: `npm ci`.
2. Stop the containerised application services so they do not compete with the local ones for queues and ports: `docker compose stop` (infrastructure is restarted in the next step).
3. Start the services you need:

   ```sh
   npm run dev -- auth-service order-service product-service payment-service inventory-service
   npm run dev -- all            # every service, including the gateway on :8080 (~2 GB RAM)
   npm run dev -- --infra-only   # only infrastructure + migrations
   ```

`npm run dev` (`scripts/dev.mjs`) does the following:

- starts `postgres`, `redis`, `rabbitmq`, `mailpit` and `jaeger` with the override file [`docker-compose.dev.yml`](../../docker-compose.dev.yml), which publishes PostgreSQL `5432`, RabbitMQ `5672`, Redis `6379`, Mailpit SMTP `1025` and Jaeger OTLP `4318` on `127.0.0.1`;
- runs the migrator (`docker compose run --rm --build migrator`);
- generates `secrets/jwt-private.pem` with `npm run keys:generate` if it does not exist (git-ignored), and runs `npm run db:generate`;
- runs each selected service with `tsx watch` against TypeScript sources, with the environment set to the same synthetic defaults as Compose (`localhost` URLs, `JWT_PRIVATE_KEY_FILE=secrets/jwt-private.pem`, `JWKS_URL=http://localhost:3001/.well-known/jwks.json`).

Things to know:

- Services verify tokens against the **local** auth-service's JWKS, so run `auth-service` from source too and log in against it (`http://localhost:3001/api/v1/auth/login`, or through a locally running gateway). Tokens issued by a containerised auth-service use a different key.
- order-service calls product-service and payment-service synchronously (`http://localhost:3003`, `http://localhost:3006`); run them as well when you work on orders.
- Without the gateway, call services directly on their ports (3001–3009). The gateway's rate limits and route table then do not apply.
- Traces go to Jaeger on `localhost:4318`; logs stay on stdout (no Loki export). Prometheus in Compose does not scrape host processes; read `http://localhost:<port>/metrics` directly.

To start one workspace by hand instead (e.g. under a debugger), export its variables yourself and run `npm run dev -w @emb/order-service` — the workspace script is just `tsx watch --conditions=source --import ./src/telemetry.ts src/main.ts` and loads no `.env` file.

## Environment variables

Configuration is validated with Zod at start-up; a missing or malformed value stops the process with a message naming the variable (never its value). Any variable below can instead be provided as `<NAME>_FILE` pointing to a file whose contents are used (Docker/Kubernetes secrets); an explicitly set `<NAME>` wins.

### Shared by every service (`packages/config/src/schemas.ts`)

| Variable                                                                                                                                                              | Default                            | Notes                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                                                                                            | `development`                      | `development`, `test`, `production`                                                                 |
| `SERVICE_NAME`                                                                                                                                                        | service name                       | Used in logs, metrics and traces                                                                    |
| `PORT`                                                                                                                                                                | per service                        | See table below                                                                                     |
| `LOG_LEVEL`                                                                                                                                                           | `info`                             | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                        |
| `SHUTDOWN_TIMEOUT_MS`                                                                                                                                                 | `15000`                            | Graceful shutdown budget                                                                            |
| `HTTP_BODY_LIMIT`                                                                                                                                                     | `100kb`                            | Gateway: `256kb`                                                                                    |
| `TRUST_PROXY`                                                                                                                                                         | `loopback, linklocal, uniquelocal` | Express `trust proxy`; must match your proxy chain                                                  |
| `CORS_ALLOWED_ORIGINS`                                                                                                                                                | empty                              | Comma-separated exact origins (Compose gateway: `http://localhost:5173`)                            |
| `METRICS_ENABLED`                                                                                                                                                     | `true`                             | Serves `/metrics`                                                                                   |
| `DOCS_ENABLED`                                                                                                                                                        | `true`                             | Serves `/docs` (Swagger UI)                                                                         |
| `OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | SDK defaults                       | Standard OpenTelemetry variables, see [observability](../operations/observability.md#configuration) |

### Per service

Required variables have no default (marked **required**).

| Service (port)                  | Variable                                                                                                                                                                            | Default                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **api-gateway** (8080)          | `REDIS_URL`                                                                                                                                                                         | **required**                                                       |
|                                 | `AUTH_SERVICE_URL`, `USER_SERVICE_URL`, `PRODUCT_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `ORDER_SERVICE_URL`, `PAYMENT_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `AUDIT_SERVICE_URL` | **required**                                                       |
|                                 | `METRICS_PORT`                                                                                                                                                                      | `9464`                                                             |
|                                 | `UPSTREAM_TIMEOUT_MS`                                                                                                                                                               | `10000`                                                            |
|                                 | `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX`                                                                                                                   | `60000` / `300` / `20`                                             |
| **auth-service** (3001)         | `DATABASE_URL`, `RABBITMQ_URL`, `JWT_PRIVATE_KEY` (or `JWT_PRIVATE_KEY_FILE`)                                                                                                       | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE`                                                                                                                                                                | `10`                                                               |
|                                 | `JWT_PREVIOUS_PUBLIC_KEY`                                                                                                                                                           | unset (key rotation)                                               |
|                                 | `ACCESS_TOKEN_TTL_SECONDS`                                                                                                                                                          | `900` (60–3600)                                                    |
|                                 | `REFRESH_TOKEN_TTL_SECONDS`                                                                                                                                                         | `604800` (1 h–30 days)                                             |
|                                 | `PASSWORD_RESET_TTL_SECONDS`                                                                                                                                                        | `900` (300–3600)                                                   |
|                                 | `PASSWORD_RESET_URL`                                                                                                                                                                | `http://localhost:8080/reset-password`                             |
|                                 | `MAX_FAILED_LOGINS` / `LOCKOUT_SECONDS`                                                                                                                                             | `5` / `900`                                                        |
|                                 | `COOKIE_SECURE`                                                                                                                                                                     | `true` (Compose: `false`)                                          |
|                                 | `ADMIN_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD` (min. 12 chars)                                                                                                                           | unset (Compose: `admin@example.test` / `local-dev-admin-password`) |
| **user-service** (3002)         | `DATABASE_URL`, `RABBITMQ_URL`, `JWKS_URL`                                                                                                                                          | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE`                                                                                                                                                                | `10`                                                               |
| **product-service** (3003)      | `DATABASE_URL`, `RABBITMQ_URL`, `REDIS_URL`, `JWKS_URL`, `INTERNAL_API_TOKEN` (min. 32 chars)                                                                                       | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE`                                                                                                                                                                | `10`                                                               |
|                                 | `CACHE_DETAIL_TTL_SECONDS` / `CACHE_LIST_TTL_SECONDS`                                                                                                                               | `300` / `60`                                                       |
| **inventory-service** (3004)    | `DATABASE_URL`, `RABBITMQ_URL`, `JWKS_URL`                                                                                                                                          | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE` / `CONSUMER_PREFETCH`                                                                                                                                          | `10` / `10`                                                        |
|                                 | `RESERVATION_TTL_MS`                                                                                                                                                                | `900000` (15 min)                                                  |
| **order-service** (3005)        | `DATABASE_URL`, `RABBITMQ_URL`, `JWKS_URL`, `INTERNAL_API_TOKEN`, `PRODUCT_SERVICE_URL`, `PAYMENT_SERVICE_URL`                                                                      | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE` / `CONSUMER_PREFETCH`                                                                                                                                          | `10` / `10`                                                        |
|                                 | `UPSTREAM_TIMEOUT_MS`                                                                                                                                                               | `2000`                                                             |
|                                 | `SAGA_INVENTORY_TIMEOUT_MS`                                                                                                                                                         | `60000`                                                            |
|                                 | `SAGA_PAYMENT_TIMEOUT_MS`                                                                                                                                                           | `60000` (Compose: `15000`)                                         |
|                                 | `SAGA_MAX_PAYMENT_ATTEMPTS`                                                                                                                                                         | `3`                                                                |
|                                 | `MAX_ORDER_LINES`                                                                                                                                                                   | `20` (distinct products per order)                                 |
| **payment-service** (3006)      | `DATABASE_URL`, `RABBITMQ_URL`, `JWKS_URL`, `INTERNAL_API_TOKEN`                                                                                                                    | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE` / `CONSUMER_PREFETCH`                                                                                                                                          | `10` / `10`                                                        |
|                                 | `SIMULATOR_LATENCY_MS`                                                                                                                                                              | `50`                                                               |
|                                 | `SIMULATOR_TIMEOUT_RESOLVES_AFTER_MS`                                                                                                                                               | `20000`                                                            |
|                                 | `RECONCILE_AFTER_MS`                                                                                                                                                                | `20000`                                                            |
| **notification-service** (3007) | `DATABASE_URL`, `RABBITMQ_URL`, `JWKS_URL`                                                                                                                                          | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE` / `CONSUMER_PREFETCH`                                                                                                                                          | `10` / `10`                                                        |
|                                 | `EMAIL_TRANSPORT`                                                                                                                                                                   | `console` (Compose: `smtp` to Mailpit)                             |
|                                 | `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE`                                                                                                                                           | `localhost` / `1025` / `false`                                     |
|                                 | `SMTP_USER`, `SMTP_PASSWORD`                                                                                                                                                        | unset                                                              |
|                                 | `EMAIL_FROM`                                                                                                                                                                        | `Express Microservices Blueprint <no-reply@example.test>`          |
|                                 | `SIMULATE_FAILURE_DOMAIN`                                                                                                                                                           | unset (Compose: `bounce.test`; leave unset in production)          |
| **audit-service** (3008)        | `DATABASE_URL`, `RABBITMQ_URL`, `JWKS_URL`                                                                                                                                          | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE`                                                                                                                                                                | `5`                                                                |
|                                 | `AUDIT_RETENTION_DAYS`                                                                                                                                                              | `365`                                                              |
| **worker** (3009)               | `DATABASE_URL`, `RABBITMQ_URL`, `REDIS_URL`, `JWKS_URL`                                                                                                                             | **required**                                                       |
|                                 | `DATABASE_POOL_SIZE`                                                                                                                                                                | `5`                                                                |
|                                 | `SCHEDULER_ENABLED`                                                                                                                                                                 | `true`                                                             |
|                                 | `WORKER_CONCURRENCY`                                                                                                                                                                | `5` (dead letters archived concurrently)                           |
|                                 | `JOB_RUN_RETENTION_DAYS`                                                                                                                                                            | `7`                                                                |

### Docker Compose only

`.env.example` lists the variables Compose reads to build the values above: database passwords per service (`AUTH_DB_PASSWORD`, …), `POSTGRES_USER`/`POSTGRES_PASSWORD`, `RABBITMQ_USER`/`RABBITMQ_PASSWORD`, `INTERNAL_API_TOKEN`, Grafana credentials, `RUN_SEED`, and `EXTRA_CA_FILE` for image builds behind a TLS-intercepting proxy. All defaults are synthetic and for local use only.

## Next steps

- [Testing](testing.md)
- [Adding a service](adding-a-service.md)
- [Event catalog](event-catalog.md)
- [Architecture overview](../architecture/README.md)
- [Troubleshooting](../troubleshooting/README.md)
