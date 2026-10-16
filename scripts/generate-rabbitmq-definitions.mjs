#!/usr/bin/env node
// Renders the topology contract as a RabbitMQ definitions file for operators
// who prefer importing definitions (management UI / `rabbitmqctl import_definitions`).
// Requires `npm run build`. Contains no users or credentials.
import { writeFileSync } from 'node:fs';
import {
  CONSUMER_QUEUES,
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
  MAINTENANCE_EXCHANGE,
  mainQueueArguments,
  retryQueueArguments,
  retryQueueName,
} from '@emb/contracts';

const vhost = '/';
const exchanges = [EVENTS_EXCHANGE, MAINTENANCE_EXCHANGE, DEAD_LETTER_EXCHANGE].map((name) => ({
  name,
  vhost,
  type: 'topic',
  durable: true,
  auto_delete: false,
  internal: false,
  arguments: {},
}));
const queues = [];
const bindings = [];
for (const queue of Object.values(CONSUMER_QUEUES)) {
  queues.push({
    name: queue.name,
    vhost,
    durable: true,
    auto_delete: false,
    arguments: mainQueueArguments(queue),
  });
  queue.retryDelaysMs.forEach((_delay, index) => {
    queues.push({
      name: retryQueueName(queue.name, index + 1),
      vhost,
      durable: true,
      auto_delete: false,
      arguments: retryQueueArguments(queue, index + 1),
    });
  });
  for (const binding of queue.bindings) {
    bindings.push({
      source: binding.exchange,
      vhost,
      destination: queue.name,
      destination_type: 'queue',
      routing_key: binding.routingKey,
      arguments: {},
    });
  }
}
const output = process.argv[2] ?? 'infrastructure/rabbitmq/definitions.json';
writeFileSync(output, `${JSON.stringify({ exchanges, queues, bindings }, null, 2)}\n`);
console.log(`Wrote ${queues.length} queues and ${bindings.length} bindings to ${output}`);
