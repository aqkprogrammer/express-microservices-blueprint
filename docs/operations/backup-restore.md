# Backup and restore

Each service owns one PostgreSQL database ([ADR-0004](../decisions/0004-database-per-service.md)), so backups are taken **per service database**. The commands below target the local Docker Compose stack; in production, prefer the managed database's automated backups and point-in-time recovery, and use these commands for ad-hoc exports.

> **Dumps contain personal data.** `auth_db` holds email addresses and password hashes, `users_db` and `notification_db` hold emails and display names, `orders_db` and `payment_db` hold purchase history, `audit_db` holds security events. Treat every dump as confidential: encrypt it at rest, restrict access, delete it when no longer needed, and **never commit a dump to Git**. The repository's `.gitignore` excludes `*.dump`, `*.sql.gz`, `*.backup` and `backups/` as a safety net — do not rely on it alone.

| Service              | Database          | Owner role         |
| -------------------- | ----------------- | ------------------ |
| auth-service         | `auth_db`         | `auth_svc`         |
| user-service         | `users_db`        | `users_svc`        |
| product-service      | `product_db`      | `product_svc`      |
| inventory-service    | `inventory_db`    | `inventory_svc`    |
| order-service        | `orders_db`       | `orders_svc`       |
| payment-service      | `payment_db`      | `payment_svc`      |
| notification-service | `notification_db` | `notification_svc` |
| audit-service        | `audit_db`        | `audit_svc`        |
| worker               | `worker_db`       | `worker_svc`       |

Redis holds no data worth backing up ([ADR-0007](../decisions/0007-redis-not-system-of-record.md)). RabbitMQ queue contents are transient; the topology is re-declared by the migrator.

## Back up one service database

Use the custom format (`-Fc`): compressed, and restorable selectively with `pg_restore`. `-T` disables the pseudo-TTY so binary output is not corrupted.

```sh
mkdir -p backups && chmod 700 backups
docker compose exec -T postgres pg_dump -U postgres -d orders_db -Fc > backups/orders_db-$(date +%Y%m%dT%H%M%S).dump
```

All service databases:

```sh
for db in auth_db users_db product_db inventory_db orders_db payment_db notification_db audit_db worker_db; do
  docker compose exec -T postgres pg_dump -U postgres -d "$db" -Fc > "backups/${db}-$(date +%Y%m%dT%H%M%S).dump"
done
```

Check a dump is readable:

```sh
pg_restore --list backups/orders_db-<timestamp>.dump | head      # needs a local pg_restore, or:
docker compose exec -T postgres pg_restore --list < backups/orders_db-<timestamp>.dump | head
```

Roles and their passwords are not part of a database dump. They are created by `infrastructure/postgres/init/01-create-service-databases.sh` on first start of an empty volume. `pg_dumpall --globals-only` would export them including password hashes — store such output with the same care as secrets, or recreate roles from your secret manager instead.

## Restore one service database

Restoring replaces the service's current data. Stop the service (and anything writing to it) first so it does not write during the restore:

```sh
docker compose stop order-service
docker compose exec -T postgres pg_restore -U postgres -d orders_db --clean --if-exists --exit-on-error \
  < backups/orders_db-<timestamp>.dump
docker compose start order-service
```

The dump preserves object ownership (`orders_svc`), which exists in any cluster initialised by the init script. To restore into a fresh database:

```sh
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS orders_db;"
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE orders_db OWNER orders_svc;"
docker compose exec -T postgres psql -U postgres -c "REVOKE ALL ON DATABASE orders_db FROM PUBLIC;"
docker compose exec -T postgres psql -U postgres -d orders_db \
  -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC;" -c "ALTER SCHEMA public OWNER TO orders_svc;"
docker compose exec -T postgres pg_restore -U postgres -d orders_db --exit-on-error < backups/orders_db-<timestamp>.dump
```

After restoring, run the migrator so the schema is at the current version (`prisma migrate deploy` is a no-op if it already is):

```sh
docker compose run --rm migrator
```

## Consistency across services

Per-service dumps taken at different moments are **not consistent with each other**. Restoring one database to an earlier point means:

- events it already published may be published again from restored `outbox_events` rows that were `PENDING` at dump time — consumers are idempotent, so this is safe;
- events it consumed after the dump are not re-delivered — its read models (e.g. product availability, notification recipients) and saga state may lag other services;
- `processed_messages` markers are rolled back, so a replayed message would be processed again.

After a single-service restore, check open sagas (`REQUIRES_REVIEW`, stuck `AWAITING_PAYMENT`) and reservations, and reconcile with the [runbook](runbook.md#orders-requiring-review). For a full disaster recovery, restore all databases from the same point in time where your platform supports it.

## Local volumes

`docker compose down` keeps data; **`docker compose down --volumes` deletes all local data** (`postgres-data`, `rabbitmq-data`, `loki-data`, `prometheus-data`, `grafana-data`, `jwt-keys`). Take a dump first if the data matters. Deleting `jwt-keys` also invalidates every issued access token.

## Production recommendations (not implemented here)

- Automated daily backups plus WAL-based point-in-time recovery (managed service feature or tools such as pgBackRest/WAL-G).
- Encrypted, access-controlled, off-site storage with a defined retention period that matches your data-protection obligations.
- Regular, documented restore drills into an isolated environment — a backup that has never been restored is not a backup.
- Masking or synthetic data instead of production dumps for development and testing.
