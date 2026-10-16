import {
  EVENTS_EXCHANGE,
  buildEnvelope,
  events,
  type EventEnvelope,
  type EventPayload,
  type EventPayloadInput,
  type EventType,
} from '@emb/contracts';
import { getRequestContext } from '@emb/logger';
import { currentTraceparent } from '@emb/observability';
import type { SqlExecutor } from './sql.js';

export interface EnqueueOptions {
  producer: string;
  aggregateType: string;
  aggregateId: string;
  /** Defaults to the active request/message context. */
  correlationId?: string;
  causationId?: string;
}

/**
 * Transactional outbox write. MUST be called with the same transaction client
 * that performs the business change, so the event is persisted if and only if
 * the change commits. The payload is validated against the published contract
 * before it is stored, so an invalid event fails the business transaction
 * instead of poisoning consumers later.
 */
export async function enqueueEvent<T extends EventType>(
  tx: SqlExecutor,
  type: T,
  payload: EventPayloadInput<T>,
  options: EnqueueOptions,
): Promise<EventEnvelope<EventPayload<T>>> {
  const definition = events[type];
  const validated = definition.schema.parse(payload) as EventPayload<T>;
  const context = getRequestContext();
  const envelope = buildEnvelope(definition.type, definition.version, validated, {
    producer: options.producer,
    correlationId: options.correlationId ?? context?.correlationId ?? options.aggregateId,
    causationId: options.causationId ?? context?.causationId ?? context?.requestId,
    subject: options.aggregateId,
  });
  await tx.$executeRawUnsafe(
    `INSERT INTO outbox_events
       (id, aggregate_type, aggregate_id, event_type, exchange, routing_key, envelope, headers)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    envelope.id,
    options.aggregateType,
    options.aggregateId,
    `${definition.type}.v${definition.version}`,
    EVENTS_EXCHANGE,
    definition.routingKey,
    JSON.stringify(envelope),
    // Trace context captured at write time links consumer spans to the originating request.
    JSON.stringify(currentTraceparent()),
  );
  return envelope;
}
