/** AMQP header names used for retries, dead-lettering and replay. */
export const HEADERS = {
  retryAttempt: 'x-retry-attempt',
  lastError: 'x-last-error',
  originalExchange: 'x-original-exchange',
  originalRoutingKey: 'x-original-routing-key',
  originalQueue: 'x-original-queue',
  deadLetterReason: 'x-dead-letter-reason',
  correlationId: 'x-correlation-id',
  replayedFrom: 'x-replayed-from-dead-letter',
} as const;
