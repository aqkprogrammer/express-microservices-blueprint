# Adding a service

This checklist walks through adding a new service — called `shipping-service` here — with its own database, events and public endpoints. `apps/user-service` is the smallest complete example to copy from.

## 1. Scaffold the workspace

```sh
scripts/scaffold-app.sh shipping-service "Shipments for confirmed orders."        # third argument "no" skips Prisma
```

This creates `apps/shipping-service/` with:

- `package.json` (`@emb/shipping-service`, ESM) with `build`, `start` (`node --import ./dist/telemetry.js dist/main.js`) and `dev` (`tsx watch`) scripts, plus `prisma:generate`, `prisma:migrate` and `db:seed` when Prisma is enabled;
- `tsconfig.json` with project references to the shared packages;
- `prisma.config.ts` and `prisma/migrations/migration_lock.toml`.

Then add dependencies to the new `package.json` (copy the `dependencies` block of `apps/user-service/package.json`: the `@emb/*` packages, `@prisma/adapter-pg`, `@prisma/client`, `express`, `zod`), run `npm install`, and add `{ "path": "apps/shipping-service" }` to the `references` in the root `tsconfig.build.json` (the build lists every workspace explicitly).

## 2. Write the service

Copy the structure of an existing service:

| File                                        | Purpose                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/telemetry.ts`                          | `startTelemetry({ serviceName: 'shipping-service' })` — preloaded with `--import`                                                                                                        |
| `src/config.ts`                             | `baseEnvSchema.extend({ SERVICE_NAME, PORT, DATABASE_URL, DATABASE_POOL_SIZE, RABBITMQ_URL, JWKS_URL, … })`                                                                              |
| `src/main.ts`                               | Wiring: pg pool + Prisma adapter, `RabbitMQClient`, `OutboxRelay`, `MessageConsumer`, readiness checks (`databaseHealthCheck`, `rabbit.healthCheck()`), shutdown hooks, `runtime.listen` |
| `src/app.ts`                                | `createServiceApp({...})` with the service's routes and OpenAPI document                                                                                                                 |
| `src/http/routes.ts`, `src/http/openapi.ts` | Routes with `parseWith(schema, …)`, `authenticate`, `requireRoles`; OpenAPI built from the same Zod schemas                                                                              |
| `src/domain/*`                              | Business logic; keep pure decision functions in separate, unit-tested modules                                                                                                            |
| `src/messaging/handlers.ts`                 | `consumer.on('EventType', …)` registrations and `registerMaintenance(consumer, { 'all.cleanup': cleanupTask(db, logger) }, logger)`                                                      |

Rules that keep the system consistent:

- Write events only with `enqueueEvent(tx, …)` inside the transaction that makes the change, and call `relay.notify()` after commit ([ADR-0009](../decisions/0009-transactional-outbox.md)).
- Make every handler idempotent: `markMessageProcessed(tx, '<service>.<handler>', envelope.id)` in the handler transaction, or an explicit business-state anchor ([ADR-0011](../decisions/0011-idempotency.md)). Throw `NonRetryableError` only when retrying cannot help.
- Never import code from another `apps/*` workspace; share through `packages/*` or through events.
- Keep network calls out of database transactions.
- Use bounded metric labels only.

## 3. Database and migrations

1. Create `prisma/schema.prisma` with the generator block used by the other services (`provider = "prisma-client"`, `output = "../src/generated/prisma"`, `moduleFormat = "esm"`, `importFileExtension = "js"`) and append `scripts/templates/messaging-models.prisma` if the service publishes or consumes events.
2. Generate the initial migration without a database:

   ```sh
   scripts/init-migration.sh shipping-service                       # optional 2nd argument: extra SQL (CHECK constraints, …)
   npm run db:generate
   ```

   This writes `prisma/migrations/20261016000000_init/migration.sql` and appends the outbox `CHECK` constraints from `scripts/templates/messaging-constraints.sql`.

3. Add a database and role. In `infrastructure/postgres/init/01-create-service-databases.sh` add `create shipping "${SHIPPING_DB_PASSWORD}"` (creates `shipping_db` owned by `shipping_svc`, `CONNECT` revoked from `PUBLIC`), and pass `SHIPPING_DB_PASSWORD` to the `postgres` service in `docker-compose.yml` and `.env.example`.

   The init script only runs on an **empty** volume. For an existing local volume, run the same statements by hand:

   ```sh
   docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
   CREATE ROLE shipping_svc LOGIN PASSWORD 'local-dev-shipping-db-password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
   CREATE DATABASE shipping_db OWNER shipping_svc;
   REVOKE ALL ON DATABASE shipping_db FROM PUBLIC;
   \c shipping_db
   REVOKE CREATE ON SCHEMA public FROM PUBLIC;
   ALTER SCHEMA public OWNER TO shipping_svc;
   SQL
   ```

4. Register the service with the migrator: add `shipping-service` to the default `MIGRATE_SERVICES` list in `infrastructure/docker/migrate.sh` and `SHIPPING_SERVICE_DATABASE_URL` to the `migrator` environment in `docker-compose.yml`.

Later schema changes: generate the SQL with Prisma's tooling against a **scratch** database (the service role cannot create the shadow database Prisma needs, so use a throw-away database and the local superuser), review the generated `migration.sql`, commit it, and let the migrator apply it. Keep migrations backwards compatible with the previous release (expand → migrate → contract).

## 4. Events and topology

1. **New events**: add a `defineEvent({...})` entry to `packages/contracts/src/events.ts` with `type`, `version: 1`, `routingKey: '<domain>.<event>.v1'`, `producer`, `description` and a Zod `schema`. Add a v1 fixture to `tests/contract/fixtures/events.v1.json` (the contract suite requires one per event).
2. **Consuming events**: add a queue to `CONSUMER_QUEUES` in `packages/contracts/src/topology.ts`:

   ```ts
   shipping: {
     name: 'shipping-service.events',
     owner: 'shipping-service',
     bindings: [eventBinding(events.OrderConfirmed), cleanup],
     retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
     deliveryLimit: 10,
   },
   ```

   Every handler registered with `consumer.on(...)` must have a matching binding, and every specific binding must have a handler — the contract tests check both.

3. Regenerate the broker definitions and check contracts:

   ```sh
   npm run build && npm run topology:generate
   npm run test:contract
   ```

   The migrator declares the new queues before services start (`scripts/declare-topology.mjs`).

4. Audit: audit-service binds `auth.#`, `user.#`, `product.#` and `payment.#` plus selected order, inventory and notification events. Add a binding to the audit queue if the new domain's events should be audited, and extend the field allow-list in `apps/audit-service/src/domain/sanitize.ts` deliberately.
5. Document the events in the [event catalog](event-catalog.md).

## 5. Public API through the gateway

Only if clients should reach the service:

1. `apps/api-gateway/src/routes.ts`: add the upstream name, a `RouteDefinition` (`prefix`, `upstream`, bounded `label`, `strictRateLimit` if it handles credentials) and the URL in `upstreamUrls`.
2. `apps/api-gateway/src/config.ts`: add `SHIPPING_SERVICE_URL`; set it in the gateway's Compose environment and in `scripts/dev.mjs`.
3. `apps/api-gateway/src/app.ts`: add the service to `SERVICE_DOCS` for the aggregated Swagger UI.
4. `scripts/export-openapi.mjs`: add the service's OpenAPI export, then `npm run build && npm run docs:openapi`.
5. Never route `/internal/*`, `/admin/*`, `/metrics` or `/health/*` paths.
6. Add any new error codes to the [error catalogue](../api/errors.md) with a `## <code>` heading.

## 6. Docker Compose, local development and monitoring

1. `docker-compose.yml`: add a service block based on the shared anchors:

   ```yaml
   shipping-service:
     <<: *service
     build: { <<: *node-build, args: { SERVICE: shipping-service } }
     image: emb/shipping-service:local
     environment:
       <<: *service-env
       PORT: 3010
       DATABASE_URL: postgresql://shipping_svc:${SHIPPING_DB_PASSWORD:-local-dev-shipping-db-password}@postgres:5432/shipping_db
   ```

   Add it to the gateway's `depends_on` if the gateway routes to it. Do not publish its port.

2. `scripts/dev.mjs`: add an entry to `SERVICES` so `npm run dev -- shipping-service` works.
3. `infrastructure/prometheus/prometheus.yml`: add `shipping-service:3010` to the `services` scrape job.
4. The Dockerfile needs no change: the `SERVICE` build argument selects the workspace.

## 7. Tests and documentation

- Unit tests next to the code (`*.test.ts`), integration tests in `tests/integration` (Testcontainers), and e2e coverage through the gateway when the service has public endpoints — see [testing](testing.md).
- Update the [event catalog](event-catalog.md), [API overview](../api/README.md), [security model](../security/README.md) (new data, new roles) and, if the service introduces a significant design choice, a new [ADR](../decisions/README.md).
