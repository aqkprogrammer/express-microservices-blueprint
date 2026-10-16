import type { ConsumeMessage } from 'amqplib';
import { describe, expect, it } from 'vitest';
import { describeDeadLetter } from './archive.js';

const message = (
  headers: Record<string, unknown>,
  properties: Record<string, unknown> = {},
): ConsumeMessage =>
  ({
    content: Buffer.from('{"id":"x"}'),
    fields: {
      routingKey: 'order.created.v1',
      deliveryTag: 1,
      redelivered: false,
      exchange: 'dead-letters',
      consumerTag: 't',
    },
    properties: { headers, ...properties },
  }) as unknown as ConsumeMessage;

describe('describeDeadLetter', () => {
  it('reads headers written by our consumers', () => {
    const letter = describeDeadLetter(
      message(
        {
          'x-original-queue': 'inventory-service.events',
          'x-dead-letter-reason': 'retries_exhausted',
          'x-last-error': 'Error: db down',
        },
        { messageId: 'm-1', type: 'OrderCreated.v1', correlationId: 'c-1' },
      ),
    );
    expect(letter).toMatchObject({
      messageId: 'm-1',
      originalQueue: 'inventory-service.events',
      reason: 'retries_exhausted',
      eventType: 'OrderCreated.v1',
      correlationId: 'c-1',
      routingKey: 'order.created.v1',
    });
  });

  it('understands native quorum-queue dead-lettering', () => {
    const letter = describeDeadLetter(
      message({ 'x-first-death-queue': 'order-service.events', 'x-first-death-reason': 'delivery_limit' }),
    );
    expect(letter.originalQueue).toBe('order-service.events');
    expect(letter.reason).toBe('delivery_limit');
    // No message ID: a content hash keeps archiving idempotent.
    expect(letter.messageId).toMatch(/^[0-9a-f]{64}$/);
  });
});
