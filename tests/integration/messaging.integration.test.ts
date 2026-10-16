import { randomUUID } from 'node:crypto';
import {
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
  buildEnvelope,
  events,
  type ConsumerQueueDefinition,
} from '@emb/contracts';
import {
  MessageConsumer,
  NonRetryableError,
  RabbitMQClient,
  publishEnvelope,
  type ConsumedMessage,
} from '@emb/messaging';
import { startRabbitMQ, waitFor, type StartedDependency } from '@emb/testing';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from './helpers.js';

let rabbit: StartedDependency;
let client: RabbitMQClient;
let deadLetters: { body: string; headers: Record<string, unknown> }[] = [];
let observer: amqp.ChannelModel;

const payload = events.ProductCreated.schema.parse({
  productId: randomUUID(),
  sku: 'SKU-1',
  name: 'Thing',
  priceCents: 100,
  currency: 'USD',
  status: 'active',
});

function queueFor(name: string): ConsumerQueueDefinition {
  return {
    name: `it.${name}.${randomUUID().slice(0, 6)}`,
    owner: 'integration-test',
    bindings: [{ exchange: EVENTS_EXCHANGE, routingKey: events.ProductCreated.routingKey }],
    retryDelaysMs: [200, 400],
    deliveryLimit: 10,
  };
}

async function publishProductCreated(correlationId: string = randomUUID()) {
  const envelope = buildEnvelope('ProductCreated', 1, payload, { producer: 'it', correlationId });
  await publishEnvelope(client, EVENTS_EXCHANGE, events.ProductCreated.routingKey, envelope);
  return envelope;
}

beforeAll(async () => {
  rabbit = await startRabbitMQ();
  client = new RabbitMQClient({ url: rabbit.url, logger: silentLogger, connectionName: 'it' });
  await client.connect();
  await client.waitUntilConnected();
  // Observe everything that reaches the dead-letter exchange.
  observer = await amqp.connect(rabbit.url);
  const channel = await observer.createChannel();
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });
  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, DEAD_LETTER_EXCHANGE, '#');
  await channel.consume(queue, (message) => {
    if (!message) return;
    deadLetters.push({ body: message.content.toString(), headers: message.properties.headers ?? {} });
    channel.ack(message);
  });
}, 240_000);

afterAll(async () => {
  await observer?.close();
  await client?.close();
  await rabbit?.stop();
});

async function startConsumer(
  definition: ConsumerQueueDefinition,
  register: (consumer: MessageConsumer) => void,
) {
  const consumer = new MessageConsumer({
    client,
    queue: definition,
    logger: silentLogger,
    prefetch: 5,
    drainTimeoutMs: 5_000,
  });
  register(consumer);
  consumer.start();
  // Wait until the queue exists and is bound before publishing.
  await waitFor(async () => {
    const connection = await amqp.connect(rabbit.url);
    try {
      const channel = await connection.createChannel();
      const ok = await channel.checkQueue(definition.name).then(
        () => true,
        () => false,
      );
      return ok || undefined;
    } finally {
      await connection.close().catch(() => undefined);
    }
  });
  return consumer;
}

describe('RabbitMQ messaging (real broker)', () => {
  it('delivers a confirmed, validated envelope and acknowledges it', async () => {
    const received: ConsumedMessage[] = [];
    const consumer = await startConsumer(queueFor('success'), (c) =>
      c.on('ProductCreated', async (message) => {
        received.push(message);
      }),
    );
    const sent = await publishProductCreated('corr-success');
    await waitFor(async () => received.length === 1 || undefined);
    expect(received[0]!.envelope).toMatchObject({
      id: sent.id,
      correlationId: 'corr-success',
      payload: { sku: 'SKU-1' },
    });
    expect(received[0]!.attempt).toBe(0);
    await consumer.stop();
  });

  it('retries a transient failure through the delayed retry queue, then succeeds', async () => {
    const attempts: number[] = [];
    const consumer = await startConsumer(queueFor('retry'), (c) =>
      c.on('ProductCreated', async (message) => {
        attempts.push(message.attempt);
        if (message.attempt === 0) throw new Error('database briefly unavailable');
      }),
    );
    await publishProductCreated();
    await waitFor(async () => attempts.length === 2 || undefined, { timeoutMs: 10_000 });
    expect(attempts).toEqual([0, 1]);
    await consumer.stop();
  });

  it('dead-letters a message after retries are exhausted, with diagnostics', async () => {
    deadLetters = [];
    const definition = queueFor('exhaust');
    let calls = 0;
    const consumer = await startConsumer(definition, (c) =>
      c.on('ProductCreated', async () => {
        calls += 1;
        throw new Error('always failing');
      }),
    );
    const sent = await publishProductCreated();
    await waitFor(async () => deadLetters.find((d) => d.body.includes(sent.id)), { timeoutMs: 15_000 });
    const letter = deadLetters.find((d) => d.body.includes(sent.id))!;
    expect(calls).toBe(3); // first delivery + 2 retries
    expect(letter.headers).toMatchObject({
      'x-dead-letter-reason': 'retries_exhausted',
      'x-original-queue': definition.name,
      'x-original-routing-key': events.ProductCreated.routingKey,
    });
    expect(String(letter.headers['x-last-error'])).toContain('always failing');
    await consumer.stop();
  });

  it('sends poison messages straight to the dead-letter exchange without calling the handler', async () => {
    deadLetters = [];
    const definition = queueFor('poison');
    let called = false;
    const consumer = await startConsumer(definition, (c) =>
      c.on('ProductCreated', async () => {
        called = true;
      }),
    );
    await client.publish(EVENTS_EXCHANGE, events.ProductCreated.routingKey, Buffer.from('{not json'), {
      messageId: 'poison-1',
    });
    const invalidPayload = buildEnvelope(
      'ProductCreated',
      1,
      { productId: 'not-a-uuid' },
      { producer: 'it', correlationId: 'c' },
    );
    await publishEnvelope(client, EVENTS_EXCHANGE, events.ProductCreated.routingKey, invalidPayload);
    await waitFor(
      async () =>
        deadLetters.filter((d) => d.headers['x-original-queue'] === definition.name).length === 2 ||
        undefined,
      {
        timeoutMs: 10_000,
      },
    );
    expect(called).toBe(false);
    expect(deadLetters.every((d) => d.headers['x-dead-letter-reason'] === 'invalid_message')).toBe(true);
    await consumer.stop();
  });

  it('does not retry NonRetryableError', async () => {
    deadLetters = [];
    const definition = queueFor('nonretryable');
    let calls = 0;
    const consumer = await startConsumer(definition, (c) =>
      c.on('ProductCreated', async () => {
        calls += 1;
        throw new NonRetryableError('business invariant violated');
      }),
    );
    const sent = await publishProductCreated();
    await waitFor(async () => deadLetters.find((d) => d.body.includes(sent.id)), { timeoutMs: 10_000 });
    expect(calls).toBe(1);
    expect(deadLetters.find((d) => d.body.includes(sent.id))!.headers['x-dead-letter-reason']).toBe(
      'non_retryable',
    );
    await consumer.stop();
  });

  it('drains in-flight messages on graceful stop', async () => {
    let finished = 0;
    const consumer = await startConsumer(queueFor('drain'), (c) =>
      c.on('ProductCreated', async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
        finished += 1;
      }),
    );
    await publishProductCreated();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await consumer.stop();
    expect(finished).toBe(1);
  });

  it('surfaces broker unavailability as a failed publish, then recovers', async () => {
    await rabbit.pause();
    try {
      await expect(publishProductCreated()).rejects.toThrow();
    } finally {
      await rabbit.unpause();
    }
    await waitFor(
      async () => {
        try {
          await publishProductCreated();
          return true;
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 60_000, intervalMs: 1_000 },
    );
  });
});
