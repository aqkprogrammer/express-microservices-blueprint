import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONSUMER_QUEUES, mainQueueArguments, retryQueueName } from '@emb/contracts';
import { describe, expect, it } from 'vitest';

interface Definitions {
  queues: { name: string; arguments: Record<string, unknown> }[];
  bindings: { source: string; destination: string; routing_key: string }[];
}

const definitions = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../infrastructure/rabbitmq/definitions.json'), 'utf8'),
) as Definitions;

describe('RabbitMQ definitions file matches the topology contract', () => {
  it('declares every main and retry queue with identical arguments', () => {
    for (const queue of Object.values(CONSUMER_QUEUES)) {
      const main = definitions.queues.find((q) => q.name === queue.name);
      expect(main?.arguments, queue.name).toEqual(mainQueueArguments(queue));
      queue.retryDelaysMs.forEach((_delay, index) => {
        expect(definitions.queues.some((q) => q.name === retryQueueName(queue.name, index + 1))).toBe(true);
      });
    }
  });

  it('declares every binding (regenerate with npm run topology:generate)', () => {
    const expected = Object.values(CONSUMER_QUEUES).flatMap((queue) =>
      queue.bindings.map((binding) => `${binding.exchange}→${queue.name}:${binding.routingKey}`),
    );
    const actual = definitions.bindings.map(
      (binding) => `${binding.source}→${binding.destination}:${binding.routing_key}`,
    );
    expect(actual.sort()).toEqual(expected.sort());
  });
});
