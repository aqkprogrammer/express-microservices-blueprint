#!/usr/bin/env node
// Declares every exchange, consumer queue, retry queue and binding from the
// shared topology contract. Run as a release step (the migrator does this)
// so no event is published before the queue that should receive it exists.
import { CONSUMER_QUEUES } from '@emb/contracts';
import { assertConsumerQueue } from '@emb/messaging';
import amqp from 'amqplib';

const url = process.env.RABBITMQ_URL;
if (!url) {
  console.error('RABBITMQ_URL is required');
  process.exit(1);
}
const deadline = Date.now() + 120_000;
let connection;
for (;;) {
  try {
    connection = await amqp.connect(url);
    break;
  } catch (error) {
    if (Date.now() > deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
const channel = await connection.createChannel();
for (const queue of Object.values(CONSUMER_QUEUES)) {
  await assertConsumerQueue(channel, queue);
  console.log(
    JSON.stringify({ level: 'info', service: 'migrator', queue: queue.name, message: 'queue declared' }),
  );
}
await channel.close();
await connection.close();
