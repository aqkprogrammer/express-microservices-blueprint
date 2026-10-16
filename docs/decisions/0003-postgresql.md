# ADR-0003: PostgreSQL as the system of record

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The domain (accounts, orders, payments, stock) needs transactions, strong constraints and concurrency control: stock must never be oversold, a payment must exist at most once per order, and an event must be stored if and only if the business change commits. The same database must also host the infrastructure tables of the messaging patterns (outbox, processed-message markers, idempotency records).

## Decision

Every stateful service stores its data in **PostgreSQL 17**. The database is the single source of truth; caches and brokers are derived from it.

Features the implementation relies on:

| Feature                                  | Used for                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ACID transactions                        | Business change + outbox row + processed-message marker in one commit                                                  |
| `CHECK` constraints                      | `reserved <= on_hand`, `on_hand >= 0`, status enums, `method_token ~ '^sim_[a-z_]+$'`, line totals                     |
| Unique constraints                       | One payment per order, one reservation per order, `(customer_id, idempotency_key)` on orders, `(consumer, message_id)` |
| `SELECT … FOR UPDATE`                    | Serialising saga events per order, payment state changes                                                               |
| `FOR UPDATE SKIP LOCKED`                 | Outbox claiming and reservation expiry without blocking other workers                                                  |
| Conditional `UPDATE … WHERE … RETURNING` | Oversell-proof stock reservation                                                                                       |
| Triggers                                 | Append-only `audit_records` (UPDATE blocked)                                                                           |
| `pg_trgm`                                | Product search                                                                                                         |
| `jsonb`                                  | Event envelopes, AMQP headers, notification data                                                                       |

## Consequences

### Positive

- Correctness guarantees live in the database, not only in application code: a bug in a handler cannot violate `reserved <= on_hand`.
- One well-understood technology for all persistent state, including messaging infrastructure tables.
- Mature tooling for backup (`pg_dump`), monitoring and managed hosting.

### Negative and trade-offs

- Vertical scaling limits apply per database. Read-heavy paths use a cache (see [ADR-0007](0007-redis-not-system-of-record.md)); write scaling beyond one primary would need partitioning or a different store.
- Polling-based outbox relays add a steady, small query load (see [ADR-0009](0009-transactional-outbox.md)).
- Locally all service databases share one PostgreSQL server for convenience. That is a single point of failure and a shared resource (`max_connections=200`) — acceptable for development, not a production recommendation.

## Alternatives considered

| Option                         | Why not chosen                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| MySQL / MariaDB                | Viable; PostgreSQL's `SKIP LOCKED`, partial indexes, `jsonb` and trigram search are used directly. |
| MongoDB                        | Weaker fit for multi-row invariants and relational constraints in this domain.                     |
| Event store as primary storage | Event sourcing is a larger paradigm shift than this blueprint aims to teach.                       |

## Operational cost

- Backups, restore drills, upgrades, connection management and monitoring per database (see [backup and restore](../operations/backup-restore.md)).
- In production a managed PostgreSQL service (with automated backups and failover) is the recommended starting point; running it yourself requires DBA skills.
