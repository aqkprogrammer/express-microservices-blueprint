import { counter, gauge, histogram } from '@emb/observability';

export const consumedTotal = counter('messaging_messages_consumed_total', 'Messages consumed by outcome', [
  'queue',
  'event_type',
  'outcome',
]);
export const processingDuration = histogram(
  'messaging_message_processing_duration_seconds',
  'Handler duration per message',
  ['queue', 'event_type'],
);
export const publishedTotal = counter(
  'messaging_messages_published_total',
  'Messages published with broker confirm',
  ['exchange', 'outcome'],
);
export const retriesTotal = counter('messaging_retries_total', 'Messages scheduled for delayed retry', [
  'queue',
]);
export const deadLetteredTotal = counter(
  'messaging_dead_lettered_total',
  'Messages sent to the dead-letter exchange',
  ['queue', 'reason'],
);
export const connectionUp = gauge('messaging_connection_up', '1 while connected to RabbitMQ');
export const inFlightMessages = gauge('messaging_messages_in_flight', 'Messages currently being handled', [
  'queue',
]);
