# Testing

Tests are organised in layers that run as separate Vitest projects (`vitest.config.ts`), so each layer can be run and scheduled on its own. Test results, coverage figures and load-test numbers are **not published** in this documentation; run the suites yourself to see current results.

| Layer       | Command                    | Location                                                 | Needs                              | What it covers                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------- | -------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | `npm run test:unit`        | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | Node only                          | Pure logic: state machines (order, payment, reservation), saga reconciliation decisions, circuit breaker, HTTP client, config loading, token handling, gateway routing/path normalisation, sanitisation, templates, scheduler                                                   |
| Contract    | `npm run test:contract`    | `tests/contract`                                         | Node only                          | Event payloads against frozen v1 fixtures (`tests/contract/fixtures/events.v1.json`), producer/consumer bindings derived from source code, `definitions.json` against the topology contract, OpenAPI documents (valid 3.1, only gateway-routed paths, error responses declared) |
| Integration | `npm run test:integration` | `tests/integration`                                      | **Docker** (Testcontainers)        | Real PostgreSQL, RabbitMQ and Redis: concurrency and oversell protection, outbox relay, messaging retries/DLQ, saga orchestration and reconciliation, auth flows, product cache                                                                                                 |
| End to end  | `npm run test:e2e`         | `tests/e2e`                                              | **Running Compose stack**          | Through the public gateway: auth flows, gateway edge behaviour, full order saga including compensation, idempotency and failure scenarios                                                                                                                                       |
| Resilience  | `npm run test:resilience`  | `tests/resilience`                                       | **Running Compose stack**          | Failure scenarios against the live stack (long time-outs, up to 240 s per test)                                                                                                                                                                                                 |
| Load        | `npm run test:load`        | `scripts/run-k6.mjs`                                     | **Running Compose stack** + Docker | k6 run in a container against the gateway                                                                                                                                                                                                                                       |

`npm test` runs unit and contract tests — the fast default for every change. `npm run test:coverage` runs the unit project with V8 coverage.

## Unit and contract tests

```sh
npm ci
npm test                     # unit + contract
npx vitest --project unit    # watch mode
npx vitest run apps/order-service/src/domain/order.test.ts
```

Packages resolve to their TypeScript sources through the `source` export condition, so no build is required. Prisma clients must exist for code that imports them: run `npm run db:generate` once after `npm ci`.

The contract suite fails when an event schema changes incompatibly with its v1 fixture, when a service handles an event its queue is not bound to, when `infrastructure/rabbitmq/definitions.json` drifts from the topology contract (`npm run topology:generate` regenerates it), or when an OpenAPI document exposes a path the gateway does not route. Staleness of the committed OpenAPI files (`docs/api/openapi/*.json`) is checked by `npm run docs:validate`; `npm run docs:openapi` regenerates them (both need `npm run build` first).

## Integration tests (Testcontainers)

```sh
npm run test:integration
```

Requires a running Docker daemon reachable by Testcontainers. Containers use the same image tags as `docker-compose.yml` (`postgres:17-alpine`, `rabbitmq:4.1-management-alpine`, `redis:8-alpine`) and are started and removed by the tests; each suite applies the real service migrations to a fresh database. The first run pulls images. Files run sequentially; hook time-outs are generous (240 s) to allow for container start-up. Set `TEST_LOG_LEVEL=debug` to see service logs.

## End-to-end and resilience tests

Start the stack first and wait until it is healthy:

```sh
npm run docker:up            # docker compose up --build -d --wait
npm run test:e2e
npm run test:resilience      # only against a disposable local stack
```

Environment variables (defaults match the Compose stack):

| Variable                   | Default                    |
| -------------------------- | -------------------------- |
| `E2E_BASE_URL`             | `http://localhost:8080`    |
| `MAILPIT_URL`              | `http://localhost:8025`    |
| `WORKER_URL`               | `http://localhost:3009`    |
| `ADMIN_EMAIL`              | `admin@example.test`       |
| `ADMIN_BOOTSTRAP_PASSWORD` | `local-dev-admin-password` |

The tests create their own users and orders and use the seeded products, so they can run repeatedly against the same stack. They depend on the Compose defaults that make failure scenarios observable (e.g. `SAGA_PAYMENT_TIMEOUT_MS=15000`, `SIMULATE_FAILURE_DOMAIN=bounce.test`); changing those in `.env` can make timing-sensitive tests fail. Credential endpoints are rate-limited (20/min/IP); running the e2e suite repeatedly in quick succession can hit that limit (`429 rate_limited`).

## Load tests

```sh
npm run docker:up
npm run test:load
```

k6 runs in a Docker container against the gateway. Output files are written to `tests/load/results/` (git-ignored). Numbers from a laptop stack with 256 MB / 0.5 CPU per service say little about production capacity; use them to compare changes, not to size infrastructure. Note the gateway rate limit (300 requests/min/IP by default) — raise `RATE_LIMIT_MAX` for load runs, or the test measures the limiter.

## Latest recorded run

This run was on 2026-10-16, before the repository was published. It used a fresh stack
(`docker compose down --volumes`, then `docker compose up --build -d --wait` with
`AUTH_RATE_LIMIT_MAX=200`) on a 4-vCPU Linux VM. These are the numbers from that one run; CI runs on
GitHub are the ongoing source of truth.

| Suite                      | Files | Tests | Result | Duration |
| -------------------------- | ----- | ----- | ------ | -------- |
| `npm run test:unit`        | 20    | 94    | passed | ≈5 s     |
| `npm run test:contract`    | 3     | 62    | passed | ≈2 s     |
| `npm run test:integration` | 6     | 43    | passed | ≈76 s    |
| `npm run test:e2e`         | 3     | 22    | passed | ≈47 s    |
| `npm run test:resilience`  | 1     | 9     | passed | ≈274 s   |

Unit-test coverage (`npm run test:coverage`) was 57% of statements and 58% of branches. It covers
`packages/*/src` and `apps/*/src`. Integration and end-to-end tests are not included in that figure.

During development, one run of `messaging.integration.test.ts` failed both retry-path tests on its
first execution. Three runs in a row afterwards passed, and the cause was not identified. If a
retry-tier test times out in CI, re-run it before investigating, and please open an issue.

## Other checks

| Command                 | Purpose                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `npm run typecheck`     | Builds all workspaces and type-checks the whole repository, including tests   |
| `npm run lint`          | ESLint                                                                        |
| `npm run format:check`  | Prettier                                                                      |
| `npm run docs:validate` | Validates documentation and checks that exported OpenAPI files are up to date |

## Writing tests

- Put pure decision logic in small modules (`order.ts`, `payment.ts`, `reservation.ts`) and unit-test them exhaustively; keep I/O in the service classes covered by integration tests.
- For every new message handler, test duplicate delivery and, where relevant, out-of-order delivery ([ADR-0011](../decisions/0011-idempotency.md)).
- For every new event or payload field, update the v1 fixture only for additive changes; see the [event catalog](event-catalog.md#versioning-policy).
- Do not assert on wall-clock timing in unit tests; inject `now()` as the circuit breaker and simulator do.
