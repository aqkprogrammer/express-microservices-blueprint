import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Every message on the bus uses this envelope. `id` is the idempotency key for
 * consumers, `correlationId` ties together all work for one business
 * transaction, and `causationId` is the ID of the message or request that
 * caused this one, forming a causal chain.
 */
export const eventEnvelopeSchema = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[A-Z][A-Za-z]+$/),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  producer: z.string().min(1),
  correlationId: z.string().min(1).max(128),
  causationId: z.string().min(1).max(128).optional(),
  subject: z.string().min(1).max(128).optional(),
  payload: z.unknown(),
});

export type EventEnvelope<TPayload = unknown> = Omit<z.infer<typeof eventEnvelopeSchema>, 'payload'> & {
  payload: TPayload;
};

export interface EnvelopeMetadata {
  producer: string;
  correlationId: string;
  causationId?: string | undefined;
  subject?: string | undefined;
  id?: string;
  occurredAt?: Date;
}

export function buildEnvelope<TPayload>(
  type: string,
  version: number,
  payload: TPayload,
  metadata: EnvelopeMetadata,
): EventEnvelope<TPayload> {
  return {
    id: metadata.id ?? randomUUID(),
    type,
    version,
    occurredAt: (metadata.occurredAt ?? new Date()).toISOString(),
    producer: metadata.producer,
    correlationId: metadata.correlationId,
    ...(metadata.causationId ? { causationId: metadata.causationId } : {}),
    ...(metadata.subject ? { subject: metadata.subject } : {}),
    payload,
  };
}

/** `OrderCreated` + 1 → `OrderCreated.v1` (the name used in docs and logs). */
export const qualifiedEventName = (type: string, version: number) => `${type}.v${version}`;
