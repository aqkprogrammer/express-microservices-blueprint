# ADR-0004: Database per service

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

A shared database couples services through their schemas: one team's migration can break another service, and "just one join" across service tables quietly creates a distributed monolith. Services must be deployable and changeable independently, and a compromised service should not be able to read other services' data.

## Decision

- **One database and one login role per service** (`auth_db`/`auth_svc`, `users_db`/`users_svc`, `product_db`/`product_svc`, `inventory_db`/`inventory_svc`, `orders_db`/`orders_svc`, `payment_db`/`payment_svc`, `notification_db`/`notification_svc`, `audit_db`/`audit_svc`, `worker_db`/`worker_svc`). The API gateway has no database.
- Roles are created `NOSUPERUSER NOCREATEDB NOCREATEROLE`, each owns only its own database, and **`REVOKE ALL ON DATABASE … FROM PUBLIC`** removes the default `CONNECT` privilege, so a role cannot even connect to another service's database. `CREATE` on schema `public` is revoked from `PUBLIC` as well (`infrastructure/postgres/init/01-create-service-databases.sh`).
- **No shared Prisma schema.** Each service has its own `prisma/schema.prisma`, its own generated client (`src/generated/prisma`) and its own migration history. The messaging tables (`outbox_events`, `processed_messages`) are copied into each schema from `scripts/templates/messaging-models.prisma`, not shared.
- **Migrations are owned by the service and run as a release step**, not at service start-up. The `migrator` image (Dockerfile target `migrator`) runs `prisma migrate deploy` for each service against that service's own database URL, optionally seeds demo data, and declares the RabbitMQ topology (`infrastructure/docker/migrate.sh`). Runtime images contain no Prisma CLI and their roles are not used to run DDL at start-up.
- Data owned by another service is obtained through events (read models, e.g. product availability, notification recipients) or a synchronous internal API (order-service reads price snapshots from product-service).

## Consequences

### Positive

- Schema changes are local to one service.
- Least privilege: a leaked `orders_svc` credential exposes orders only.
- Runtime containers cannot alter schemas, and failed migrations stop the release before new code starts (`depends_on: migrator: condition: service_completed_successfully`).

### Negative and trade-offs

- No cross-service joins or foreign keys; consistency across services is eventual and maintained by events and sagas ([ADR-0010](0010-saga-orchestration-and-compensation.md)).
- Read models duplicate data (product availability, recipient email/display name) and can be briefly stale.
- Reporting across services needs a separate pipeline (e.g. events into a warehouse) — not provided here.
- Locally all databases live on one PostgreSQL server; the isolation is logical (roles and grants), not physical. In production, separate servers or at least separate managed instances per criticality tier are worth considering.
- Migrations must stay backwards compatible with the previous release (expand → migrate → contract) because the old version keeps running during a rolling deployment.

## Alternatives considered

| Option                              | Why not chosen                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared database, shared schema      | Tight coupling; any service can read or corrupt any table.                                                                                    |
| Shared database, schema per service | Better, but a single role or `search_path` mistake re-enables cross-schema access; database-level `CONNECT` revocation is a simpler boundary. |
| Run migrations at service start-up  | Concurrent replicas race on migrations, runtime roles would need DDL rights and the Prisma CLI would ship in runtime images.                  |

## Operational cost

- Nine databases to back up, monitor and upgrade (see [backup and restore](../operations/backup-restore.md)).
- Nine credentials to rotate.
- One release step (the migrator) that must succeed before services start; in Kubernetes this becomes a Job or pre-deploy hook (see [Kubernetes deployment](../deployment/kubernetes.md)).
