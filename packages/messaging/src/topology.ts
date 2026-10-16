import {
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
  MAINTENANCE_EXCHANGE,
  mainQueueArguments,
  retryQueueArguments,
  retryQueueName,
  type ConsumerQueueDefinition,
} from '@emb/contracts';
import type { Channel } from 'amqplib';

export async function assertExchanges(channel: Channel): Promise<void> {
  for (const exchange of [EVENTS_EXCHANGE, MAINTENANCE_EXCHANGE, DEAD_LETTER_EXCHANGE]) {
    await channel.assertExchange(exchange, 'topic', { durable: true });
  }
}

/** Idempotently declares a consumer queue, its retry tiers and bindings. */
export async function assertConsumerQueue(channel: Channel, queue: ConsumerQueueDefinition): Promise<void> {
  await assertExchanges(channel);
  await channel.assertQueue(queue.name, { durable: true, arguments: mainQueueArguments(queue) });
  for (let attempt = 1; attempt <= queue.retryDelaysMs.length; attempt += 1) {
    await channel.assertQueue(retryQueueName(queue.name, attempt), {
      durable: true,
      arguments: retryQueueArguments(queue, attempt),
    });
  }
  for (const binding of queue.bindings) {
    await channel.bindQueue(queue.name, binding.exchange, binding.routingKey);
  }
}
