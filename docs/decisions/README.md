# Architecture decision records

Each record captures one significant decision: the forces behind it, what was chosen, what it costs, and what was rejected. Records are immutable once accepted; a changed decision gets a new record that supersedes the old one.

| ADR                                                           | Title                                                                   | Status   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- | -------- |
| [0001](0001-express-and-typescript.md)                        | Express.js and TypeScript for every service                             | Accepted |
| [0002](0002-npm-workspaces-monorepo.md)                       | npm-workspaces monorepo                                                 | Accepted |
| [0003](0003-postgresql.md)                                    | PostgreSQL as the system of record                                      | Accepted |
| [0004](0004-database-per-service.md)                          | Database per service                                                    | Accepted |
| [0005](0005-rabbitmq-default-broker.md)                       | RabbitMQ as the default message broker                                  | Accepted |
| [0006](0006-when-kafka-is-appropriate.md)                     | When Kafka is appropriate (not deployed here)                           | Accepted |
| [0007](0007-redis-not-system-of-record.md)                    | Redis is not the system of record                                       | Accepted |
| [0008](0008-api-gateway-without-business-logic.md)            | API gateway without business logic                                      | Accepted |
| [0009](0009-transactional-outbox.md)                          | Transactional outbox                                                    | Accepted |
| [0010](0010-saga-orchestration-and-compensation.md)           | Saga orchestration and compensation                                     | Accepted |
| [0011](0011-idempotency.md)                                   | Idempotency for messages and REST commands                              | Accepted |
| [0012](0012-observability-across-service-boundaries.md)       | Observability across service boundaries                                 | Accepted |
| [0013](0013-when-kubernetes-becomes-worthwhile.md)            | When Kubernetes becomes worthwhile                                      | Accepted |
| [0014](0014-prisma-driver-adapters-and-raw-sql.md)            | Prisma 7 with driver adapters, raw SQL for concurrency-critical updates | Accepted |
| [0015](0015-reference-authentication-vs-identity-provider.md) | Reference authentication implementation vs external identity provider   | Accepted |

## Template

New records copy this structure:

```markdown
# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-NNNN
- **Date:** YYYY-MM-DD

## Context

What forces are at play? What problem needs a decision?

## Decision

What we do, stated in full sentences.

## Consequences

### Positive

### Negative and trade-offs

## Alternatives considered

Each option with the reason it was not chosen.

## Operational cost

What running this decision costs: infrastructure, on-call load, skills, upgrades.
```

Number records sequentially and add them to the table above. Use "Accepted" only for decisions that the code implements; recommendations that are not implemented must be labelled as such in the text.
