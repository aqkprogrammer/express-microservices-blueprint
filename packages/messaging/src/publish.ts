import type { EventEnvelope } from '@emb/contracts';
import { injectTraceHeaders } from '@emb/observability';
import type { RabbitMQClient } from './connection.js';
import { HEADERS } from './headers.js';

/** Publishes an envelope directly (no outbox). Used for scheduler commands and replays. */
export async function publishEnvelope(
  client: RabbitMQClient,
  exchange: string,
  routingKey: string,
  envelope: EventEnvelope,
  headers: Record<string, string> = {},
): Promise<void> {
  await client.publish(exchange, routingKey, Buffer.from(JSON.stringify(envelope)), {
    messageId: envelope.id,
    type: `${envelope.type}.v${envelope.version}`,
    appId: envelope.producer,
    timestamp: Math.floor(new Date(envelope.occurredAt).getTime() / 1000),
    correlationId: envelope.correlationId,
    headers: injectTraceHeaders({ [HEADERS.correlationId]: envelope.correlationId, ...headers }),
  });
}
