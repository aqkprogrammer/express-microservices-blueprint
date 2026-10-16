# ADR-0006: When Kafka is appropriate (not deployed here)

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Teams adopting this blueprint regularly ask whether they should use Apache Kafka instead of RabbitMQ. The two solve overlapping but different problems. This record states when this blueprint would recommend Kafka, so the RabbitMQ choice in [ADR-0005](0005-rabbitmq-default-broker.md) is not mistaken for a universal rule.

**Kafka is not part of this repository.** Nothing here is implemented on Kafka; this record is guidance.

## Decision

Keep RabbitMQ as the default broker. Recommend introducing Kafka (or a managed log such as Amazon MSK, Confluent Cloud, Azure Event Hubs with the Kafka API, or Redpanda) when one or more of these needs is real, not hypothetical:

| Need                                                                                     | Why a log fits better                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Replay** — rebuild a read model, backfill a new consumer, or reprocess after a bug fix | Kafka retains messages for a configured period independent of consumption; consumers can reset offsets. RabbitMQ deletes acknowledged messages. |
| **High sustained throughput** — telemetry, clickstream, CDC feeds                        | Partitioned, append-only logs with batching scale horizontally for very high message rates.                                                     |
| **Stream processing** — windowed aggregations, joins between streams, materialised views | Kafka Streams, Flink and ksqlDB operate natively on logs.                                                                                       |
| **Strict per-key ordering at scale**                                                     | Ordering per partition key is a core property; RabbitMQ ordering is per queue and lost on retry.                                                |
| **Event-sourcing or audit streams consumed by many teams**                               | Long retention and independent consumer groups.                                                                                                 |

Keep RabbitMQ when the workload looks like this repository's: business commands and events at moderate rates, per-message acknowledgement, per-consumer retry and dead-lettering, and routing by topic patterns.

The two can coexist: RabbitMQ for workflow messaging between services, Kafka for analytics and replayable streams fed from the same outbox or from change data capture.

## Consequences

### Positive

- The default stays simple to run locally and in production.
- The criteria above give a concrete trigger for revisiting the choice.

### Negative and trade-offs

- Without a log, adding a consumer that needs historical events requires a bespoke backfill (e.g. from the producer's database).
- If Kafka is introduced later, consumers must still be idempotent; Kafka does not remove the need for the patterns in [ADR-0011](0011-idempotency.md). Retry and dead-letter handling (retry topics, DLQ topics) must be implemented explicitly, because Kafka has no per-message nack.

## Alternatives considered

| Option                    | Why not chosen as the default                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Kafka as the only broker  | Operational weight (partitions, consumer-group rebalancing, retention sizing) without a current need for replay or high throughput. |
| Both brokers from day one | Two systems to run and learn before either is justified.                                                                            |

## Operational cost

If adopted: a multi-broker cluster or managed service, partition and retention planning, schema governance (e.g. a schema registry), consumer-lag monitoring, and team training. This cost should be weighed against the concrete needs listed above.
