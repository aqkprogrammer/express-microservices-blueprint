import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSUMER_QUEUES,
  EVENTS_EXCHANGE,
  allEventDefinitions,
  buildEnvelope,
  eventEnvelopeSchema,
  events,
  type EventType,
} from '@emb/contracts';
import { describe, expect, it } from 'vitest';

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/events.v1.json'), 'utf8'),
) as Record<string, unknown>;
const appsDir = join(import.meta.dirname, '../../apps');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Which service source code produces / consumes which events (found by scanning the code). */
const producers = new Map<string, Set<string>>();
const consumers = new Map<string, Set<string>>();
for (const service of readdirSync(appsDir)) {
  for (const file of sourceFiles(join(appsDir, service, 'src'))) {
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/enqueueEvent\(\s*\w+,\s*'([A-Za-z]+)'/g)) {
      producers.set(match[1]!, (producers.get(match[1]!) ?? new Set()).add(service));
    }
    // Consumer registrations live in each service's messaging module.
    if (!file.includes(join('src', 'messaging'))) continue;
    for (const match of code.matchAll(/\.on\('([A-Za-z]+)'/g)) {
      consumers.set(service, (consumers.get(service) ?? new Set()).add(match[1]!));
    }
  }
}

const queueOf = (service: string) => Object.values(CONSUMER_QUEUES).find((queue) => queue.owner === service);

describe('event schema compatibility (v1 fixtures)', () => {
  it('has a frozen fixture for every catalog event', () => {
    expect(
      Object.keys(fixtures)
        .filter((key) => !key.startsWith('_'))
        .sort(),
    ).toEqual(Object.keys(events).sort());
  });

  for (const type of Object.keys(events) as EventType[]) {
    it(`${type}.v${events[type].version} still accepts its v1 fixture inside a valid envelope`, () => {
      const payload = events[type].schema.parse(fixtures[type]);
      const envelope = buildEnvelope(type, events[type].version, payload, {
        producer: 'contract-test',
        correlationId: 'c-1',
      });
      expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
    });
  }

  it('rejects payloads missing required fields (consumers can rely on them)', () => {
    const { orderId: _orderId, ...withoutOrderId } = fixtures.OrderCreated as Record<string, unknown>;
    expect(events.OrderCreated.schema.safeParse(withoutOrderId).success).toBe(false);
  });
});

describe('producer / consumer contracts (derived from source code)', () => {
  it('every event a service handles is bound to that service’s queue', () => {
    for (const [service, handled] of consumers) {
      const queue = queueOf(service);
      expect(queue, `${service} consumes events but has no queue`).toBeDefined();
      const keys = new Set(
        queue!.bindings
          .filter((binding) => binding.exchange === EVENTS_EXCHANGE)
          .map((binding) => binding.routingKey),
      );
      for (const type of handled) {
        const definition = events[type as EventType];
        expect(definition, `${service} handles unknown event ${type}`).toBeDefined();
        expect(
          keys.has(definition.routingKey),
          `${service} handles ${type} but does not bind ${definition.routingKey}`,
        ).toBe(true);
      }
    }
  });

  it('every specific binding is consumed by a handler in the owning service', () => {
    for (const queue of Object.values(CONSUMER_QUEUES)) {
      if (queue.owner === 'audit-service' || queue.owner === 'worker') continue; // catch-all consumers
      const handled = consumers.get(queue.owner) ?? new Set();
      for (const binding of queue.bindings.filter((b) => b.exchange === EVENTS_EXCHANGE)) {
        const definition = allEventDefinitions().find((d) => d.routingKey === binding.routingKey);
        expect(
          definition && handled.has(definition.type),
          `${queue.name} binds ${binding.routingKey} without a handler`,
        ).toBe(true);
      }
    }
  });

  it('every consumed event has at least one producer, and producers match the catalog', () => {
    const consumed = new Set([...consumers.values()].flatMap((set) => [...set]));
    for (const type of consumed)
      expect(producers.has(type), `${type} is consumed but never produced`).toBe(true);
    for (const [type, services] of producers) {
      const declared = events[type as EventType].producer;
      if (declared !== 'any') expect([...services], `${type} producer`).toEqual([declared]);
    }
  });
});
