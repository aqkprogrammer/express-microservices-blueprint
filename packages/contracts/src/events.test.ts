import { describe, expect, it } from 'vitest';
import { buildEnvelope, eventEnvelopeSchema, qualifiedEventName } from './envelope.js';
import { allEventDefinitions, events, findEventDefinition } from './events.js';
import { CONSUMER_QUEUES, EVENTS_EXCHANGE, mainQueueArguments, retryQueueArguments } from './topology.js';

describe('event catalog', () => {
  it('uses unique, versioned routing keys', () => {
    const keys = allEventDefinitions().map((definition) => definition.routingKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const definition of allEventDefinitions()) {
      expect(definition.routingKey).toMatch(new RegExp(`\\.v${definition.version}$`));
    }
  });

  it('finds definitions by type and version', () => {
    expect(findEventDefinition('OrderCreated', 1)).toBe(events.OrderCreated);
    expect(findEventDefinition('OrderCreated', 2)).toBeUndefined();
    expect(qualifiedEventName('OrderCreated', 1)).toBe('OrderCreated.v1');
  });

  it('builds valid envelopes', () => {
    const envelope = buildEnvelope('OrderCancelled', 1, { a: 1 }, { producer: 'test', correlationId: 'c-1' });
    expect(eventEnvelopeSchema.parse(envelope)).toMatchObject({
      type: 'OrderCancelled',
      correlationId: 'c-1',
    });
    expect(envelope).not.toHaveProperty('causationId');
  });
});

describe('topology', () => {
  it('binds every consumed event key to a known event or wildcard', () => {
    const known = new Set(allEventDefinitions().map((definition) => definition.routingKey));
    for (const queue of Object.values(CONSUMER_QUEUES)) {
      for (const binding of queue.bindings) {
        if (binding.exchange !== EVENTS_EXCHANGE || binding.routingKey.includes('#')) continue;
        expect(known.has(binding.routingKey), `${queue.name} → ${binding.routingKey}`).toBe(true);
      }
    }
  });

  it('every event with a consumer is routed somewhere', () => {
    const consumed = allEventDefinitions().filter((definition) =>
      Object.values(CONSUMER_QUEUES).some((queue) =>
        queue.bindings.some((binding) => binding.routingKey === definition.routingKey),
      ),
    );
    expect(consumed.map((definition) => definition.type)).toContain('OrderCreated');
  });

  it('routes expired retries back to the main queue', () => {
    const queue = CONSUMER_QUEUES.order;
    expect(mainQueueArguments(queue)['x-dead-letter-exchange']).toBe('dead-letters');
    expect(retryQueueArguments(queue, 2)).toMatchObject({
      'x-message-ttl': queue.retryDelaysMs[1],
      'x-dead-letter-routing-key': queue.name,
    });
    expect(() => retryQueueArguments(queue, 99)).toThrow();
    expect(mainQueueArguments(CONSUMER_QUEUES.deadLetters)).not.toHaveProperty('x-dead-letter-exchange');
  });
});
