# ADR-0014: Prisma 7 with driver adapters, raw SQL for concurrency-critical updates

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Services need type-safe data access and versioned migrations, but the most important writes — stock reservation, outbox claiming, saga event serialisation, idempotency markers — depend on precise SQL semantics (conditional updates, row locks, `SKIP LOCKED`, `ON CONFLICT`). An ORM that hides those semantics would make the concurrency guarantees hard to see and easy to break.

## Decision

- **Prisma 7** with the `prisma-client` generator (ESM output into each service's `src/generated/prisma`) for schema definition, migrations and ordinary CRUD.
- **Driver adapter** `@prisma/adapter-pg` over a `pg.Pool` created by `createPgPool` (`packages/database/src/pool.ts`). The pool is bounded (`DATABASE_POOL_SIZE`, default 10; 5 for audit-service and worker), sets `statement_timeout` 10 s, a 5 s connection timeout, an `application_name`, and exposes `db_pool_connections{state}` and `db_pool_max_connections` metrics.
- **Raw SQL with bound parameters** (`$queryRaw` tagged templates or `$executeRawUnsafe` with positional parameters and constant SQL strings) for concurrency-critical paths:

| Path                                     | SQL                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stock reservation                        | `UPDATE inventory_items SET reserved = reserved + $q … WHERE product_id = $id AND on_hand - reserved >= $q RETURNING …`, lines in product-ID order to avoid deadlocks |
| Stock adjustment                         | `… WHERE on_hand + $delta >= reserved`                                                                                                                                |
| Outbox claim                             | `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`                                                                                                              |
| Reservation expiry                       | `SELECT … FOR UPDATE SKIP LOCKED`                                                                                                                                     |
| Saga/payment/refresh-token serialisation | `SELECT … FOR UPDATE`                                                                                                                                                 |
| Idempotent consumer                      | `INSERT … ON CONFLICT DO NOTHING`                                                                                                                                     |

- Shared helpers in `packages/database` depend on a structural `SqlExecutor` interface (`$executeRawUnsafe`, `$queryRawUnsafe`) rather than any one generated client, because every service has its own client.
- Constraints Prisma's schema language cannot express (`CHECK` constraints, triggers, `pg_trgm` indexes) are appended to the generated migration SQL (`scripts/init-migration.sh`, `scripts/templates/messaging-constraints.sql`).
- The Prisma CLI is used only at build time (`prisma generate`) and in the migrator image (`prisma migrate deploy`), never in runtime images.

## Consequences

### Positive

- Type-safe queries and generated types for most code; explicit, reviewable SQL where correctness depends on it.
- Using `pg` through the adapter gives direct control of pool size and timeouts and lets the `pg` OpenTelemetry instrumentation trace queries.
- Database `CHECK` constraints remain the last line of defence regardless of which access path is used.

### Negative and trade-offs

- Two styles of data access in one codebase; contributors must know when raw SQL is required.
- Raw SQL is not checked against the schema at compile time; a renamed column breaks at runtime. Unit and integration tests must cover these statements.
- Interactive transactions hold a pooled connection for their whole duration; long work inside a transaction (e.g. network calls) would exhaust the pool. The code keeps provider and HTTP calls outside transactions for this reason.
- Prisma 7 driver adapters and the ESM generator are relatively new; upgrades should be tested carefully.

## Alternatives considered

| Option                  | Why not chosen                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma only, no raw SQL | Conditional updates with `RETURNING`, `SKIP LOCKED` and `ON CONFLICT DO NOTHING` semantics are not expressible (or not obviously) through the query API. |
| Drizzle ORM             | Closer to SQL and lightweight; a reasonable alternative. Prisma was chosen for its migration workflow and familiarity.                                   |
| Kysely / plain `pg`     | Maximum control, but no schema-driven migrations or generated models.                                                                                    |
| TypeORM / Sequelize     | Heavier abstractions, weaker type inference.                                                                                                             |

## Operational cost

- `npm run db:generate` is part of the build; generated clients are not committed.
- Pool sizes must be planned against PostgreSQL `max_connections` across all replicas (see [runbook](../operations/runbook.md#database-pool-exhaustion)).
