export { RabbitMQClient, type RabbitMQClientOptions, type PublishOptions } from './connection.js';
export { assertConsumerQueue, assertExchanges } from './topology.js';
export {
  MessageConsumer,
  NonRetryableError,
  type ConsumedMessage,
  type ConsumerOptions,
  type MessageHandler,
} from './consumer.js';
export { OutboxRelay, type OutboxRelayOptions } from './outbox-relay.js';
export { publishEnvelope } from './publish.js';
export { HEADERS } from './headers.js';
export { registerMaintenance, cleanupTask, type CleanupOptions } from './maintenance.js';
