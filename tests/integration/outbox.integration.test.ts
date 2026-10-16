import { randomUUID } from 'node:crypto';
import { CONSUMER_QUEUES, EVENTS_EXCHANGE } from '@emb/contracts';
import { enqueueEvent } from '@emb/database';
import { OutboxRelay, RabbitMQClient } from '@emb/messaging';
import { startPostgres, startRabbitMQ, waitFor, type StartedDependency } from '@emb/testing';
import amqp from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../apps/product-service/src/generated/prisma/client.js';
import { createServiceDatabase, prismaFor, silentLogger } from './helpers.js';

let postgres: StartedDependency;
let rabbit: StartedDependency;
let db: ReturnType<typeof prismaFor<PrismaClient>>;
let client: RabbitMQClient;
let observer: amqp.ChannelModel;
const received: string[] = [];

const productPayload = () => ({
  productId: randomUUID(),
  sku: `SKU-${randomUUID().slice(0, 6)}`.toUpperCase(),
  name: 'Outbox test product',
  priceCents: 100,
  currency: 'USD',
  status: 'active' as const,
});

async function writeEvents(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await db.client.$transaction(async (tx) => {
      const envelope = await enqueueEvent(tx, 'ProductCreated', productPayload(), {
        producer: 'product-service',
        aggregateType: 'product',
        aggregateId: randomUUID(),
      });
      ids.push(envelope.id);
    });
  }
  return ids;
}

const statusCounts = async () =>
  Object.fromEntries(
    (
      await db.client.$queryRawUnsafe<{ status: string; n: number }[]>(
        'SELECT status, count(*)::int AS n FROM outbox_events GROUP BY status',
      )
    ).map((row) => [row.status, row.n]),
  );

beforeAll(async () => {
  [postgres, rabbit] = await Promise.all([startPostgres(), startRabbitMQ()]);
  db = prismaFor(PrismaClient, await createServiceDatabase(postgres, 'product-service'), 'outbox-it');
  client = new RabbitMQClient({ url: rabbit.url, logger: silentLogger, connectionName: 'outbox-it' });
  await client.connect();
  await client.waitUntilConnected();
  observer = await amqp.connect(rabbit.url);
  const channel = await observer.createChannel();
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, EVENTS_EXCHANGE, 'product.created.v1');
  await channel.consume(queue, (message) => {
    if (message) {
      received.push(String(message.properties.messageId));
      channel.ack(message);
    }
  });
}, 240_000);

afterAll(async () => {
  await observer?.close();
  await client?.close();
  await db?.client.$disconnect();
  await db?.close();
  await Promise.all([postgres?.stop(), rabbit?.stop()]);
});

describe('transactional outbox (real Postgres + RabbitMQ)', () => {
  it('stores nothing when the business transaction rolls back', async () => {
    await expect(
      db.client.$transaction(async (tx) => {
        await enqueueEvent(tx, 'ProductCreated', productPayload(), {
          producer: 'product-service',
          aggregateType: 'product',
          aggregateId: 'x',
        });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await statusCounts()).toEqual({});
  });

  it('rejects an event that violates its contract before it is stored', async () => {
    await expect(
      db.client.$transaction((tx) =>
        enqueueEvent(
          tx,
          'ProductCreated',
          { ...productPayload(), priceCents: -1 },
          { producer: 'product-service', aggregateType: 'product', aggregateId: 'x' },
        ),
      ),
    ).rejects.toThrow();
    expect(await statusCounts()).toEqual({});
  });

  it('publishes committed events with broker confirmation and marks them PUBLISHED', async () => {
    const ids = await writeEvents(5);
    const relay = new OutboxRelay({ db: db.client, client, logger: silentLogger });
    expect(await relay.runOnce()).toBe(5);
    await waitFor(async () => ids.every((id) => received.includes(id)) || undefined);
    expect(await statusCounts()).toEqual({ PUBLISHED: 5 });
  });

  it('lets concurrent relays share the work without double-publishing', async () => {
    received.length = 0;
    const ids = await writeEvents(60);
    const relays = [1, 2, 3].map(
      () => new OutboxRelay({ db: db.client, client, logger: silentLogger, batchSize: 7 }),
    );
    let published = 0;
    for (let round = 0; round < 20 && published < 60; round += 1) {
      published += (await Promise.all(relays.map((relay) => relay.runOnce()))).reduce((a, b) => a + b, 0);
    }
    expect(published).toBe(60);
    await waitFor(async () => received.length >= 60 || undefined);
    expect(new Set(received).size).toBe(60);
    expect(received.sort()).toEqual([...ids].sort());
  });

  it('keeps events and records attempts when publishing fails, then recovers', async () => {
    const [id] = await writeEvents(1);
    const failing = {
      isConnected: true,
      publish: () => Promise.reject(new Error('channel closed')),
    } as unknown as RabbitMQClient;
    await new OutboxRelay({ db: db.client, client: failing, logger: silentLogger }).runOnce();
    const [row] = await db.client.$queryRawUnsafe<
      { status: string; attempts: number; last_error: string; available_at: Date }[]
    >('SELECT status, attempts, last_error, available_at FROM outbox_events WHERE id = $1::uuid', id);
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'channel closed' });
    expect(row!.available_at.getTime()).toBeGreaterThan(Date.now());

    // Back-off elapsed: a healthy relay publishes it.
    await db.client.$executeRawUnsafe(
      `UPDATE outbox_events SET available_at = now() WHERE id = $1::uuid`,
      id,
    );
    await new OutboxRelay({ db: db.client, client, logger: silentLogger }).runOnce();
    await waitFor(async () => received.includes(id!) || undefined);
  });

  it('reclaims rows whose lease expired (relay crashed mid-publish)', async () => {
    const [id] = await writeEvents(1);
    await db.client.$executeRawUnsafe(
      `UPDATE outbox_events SET status = 'PUBLISHING', locked_until = now() - interval '1 second' WHERE id = $1::uuid`,
      id,
    );
    expect(await new OutboxRelay({ db: db.client, client, logger: silentLogger }).runOnce()).toBe(1);
    await waitFor(async () => received.includes(id!) || undefined);
  });

  it('uses the queue definitions shared with production code', () => {
    expect(
      CONSUMER_QUEUES.inventory.bindings.some((binding) => binding.routingKey === 'product.created.v1'),
    ).toBe(true);
  });
});
