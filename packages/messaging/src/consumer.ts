import {
  DEAD_LETTER_EXCHANGE,
  eventEnvelopeSchema,
  findEventDefinition,
  qualifiedEventName,
  retryQueueName,
  type ConsumerQueueDefinition,
  type EventEnvelope,
  type EventPayload,
  type EventType,
  events,
} from '@emb/contracts';
import type { Logger } from '@emb/logger';
import { runWithContext, serializeError } from '@emb/logger';
import { SpanKind, extractTraceContext, withSpan } from '@emb/observability';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import type { z } from 'zod';
import type { RabbitMQClient } from './connection.js';
import { HEADERS } from './headers.js';
import {
  consumedTotal,
  deadLetteredTotal,
  inFlightMessages,
  processingDuration,
  retriesTotal,
} from './metrics.js';
import { assertConsumerQueue } from './topology.js';

/** Throw from a handler when retrying cannot help (e.g. a business invariant is violated). */
export class NonRetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

export interface ConsumedMessage<TPayload = unknown> {
  envelope: EventEnvelope<TPayload>;
  routingKey: string;
  /** 0 for the first delivery, incremented for each delayed retry. */
  attempt: number;
  redelivered: boolean;
  headers: Record<string, unknown>;
  raw: ConsumeMessage;
}

export type MessageHandler<TPayload = unknown> = (message: ConsumedMessage<TPayload>) => Promise<void>;

export interface ConsumerOptions {
  client: RabbitMQClient;
  queue: ConsumerQueueDefinition;
  logger: Logger;
  /** Max unacknowledged messages in flight; bounds handler concurrency. */
  prefetch?: number;
  /** Max time `stop()` waits for in-flight handlers. */
  drainTimeoutMs?: number;
  /**
   * What to do when all retries fail. Normal consumers dead-letter; the
   * dead-letter archive itself requeues so it never loses a message.
   */
  onRetriesExhausted?: 'dead-letter' | 'requeue';
}

interface Registration {
  schema: z.ZodType;
  handler: MessageHandler;
}

type DeadLetterReason = 'invalid_message' | 'unhandled_event_type' | 'non_retryable' | 'retries_exhausted';

/**
 * Consumes one queue with manual acknowledgements and explicit failure routing:
 *   success           → ack
 *   transient failure → copy to `<queue>.retry.<n>` (TTL then back to the queue), ack original
 *   exhausted / poison→ publish to the dead-letter exchange with diagnostics, ack original
 *   cannot republish  → nack + requeue (the broker keeps the message; quorum
 *                       delivery-limit eventually dead-letters it natively)
 * A message is only acked after its outcome has been durably handed off, so
 * failures are never silently swallowed.
 */
export class MessageConsumer {
  private readonly registrations = new Map<string, Registration>();
  private fallback: MessageHandler | undefined;
  private rawHandler: ((message: ConsumeMessage) => Promise<void>) | undefined;
  private channel: Channel | undefined;
  private consumerTag: string | undefined;
  private inFlight = 0;
  private stopping = false;
  private started = false;

  constructor(private readonly options: ConsumerOptions) {}

  /** Registers a typed handler for a catalog event; payloads are validated against the contract. */
  on<T extends EventType>(type: T, handler: MessageHandler<EventPayload<T>>): this {
    const definition = events[type];
    this.registrations.set(qualifiedEventName(definition.type, definition.version), {
      schema: definition.schema,
      handler: handler as MessageHandler,
    });
    return this;
  }

  /** Registers a handler for a non-catalog message type (e.g. maintenance commands). */
  onMessage<TSchema extends z.ZodType>(
    type: string,
    version: number,
    schema: TSchema,
    handler: MessageHandler<z.output<TSchema>>,
  ): this {
    this.registrations.set(qualifiedEventName(type, version), { schema, handler: handler as MessageHandler });
    return this;
  }

  /** Handles any message without a specific registration (used by audit and the DLQ archive). */
  onAny(handler: MessageHandler): this {
    this.fallback = handler;
    return this;
  }

  /**
   * Bypasses envelope parsing entirely: the handler gets the raw AMQP message.
   * Used by the dead-letter archive, which must accept malformed messages
   * (rejecting them would dead-letter them straight back to itself).
   */
  onRaw(handler: (message: ConsumeMessage) => Promise<void>): this {
    this.rawHandler = handler;
    return this;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.client.onConnected((model) => this.subscribe(model));
  }

  private async subscribe(model: ChannelModel): Promise<void> {
    if (this.stopping) return;
    const { queue, logger } = this.options;
    const channel = await model.createChannel();
    channel.on('error', (error: Error) => {
      logger.warn({ err: serializeError(error), queue: queue.name }, 'consumer channel error');
    });
    channel.on('close', () => {
      if (this.channel === channel) this.channel = undefined;
      // A channel-level failure on a live connection needs a fresh subscription.
      if (!this.stopping && this.options.client.isConnected) {
        setTimeout(() => {
          if (!this.stopping && !this.channel) {
            this.subscribe(model).catch((error: unknown) => {
              logger.error({ err: serializeError(error), queue: queue.name }, 'consumer resubscribe failed');
            });
          }
        }, 1_000).unref();
      }
    });
    await assertConsumerQueue(channel, queue);
    await channel.prefetch(this.options.prefetch ?? 10);
    const { consumerTag } = await channel.consume(
      queue.name,
      (message) => {
        if (message) void this.handle(channel, message);
      },
      { noAck: false },
    );
    this.channel = channel;
    this.consumerTag = consumerTag;
    logger.info({ queue: queue.name, prefetch: this.options.prefetch ?? 10 }, 'consumer started');
  }

  private async handle(channel: Channel, message: ConsumeMessage): Promise<void> {
    const { queue, logger } = this.options;
    this.inFlight += 1;
    inFlightMessages.inc({ queue: queue.name });
    const headers = (message.properties.headers ?? {}) as Record<string, unknown>;
    const attempt = Number(headers[HEADERS.retryAttempt] ?? 0) || 0;
    let eventType = 'unknown';

    try {
      if (this.rawHandler) {
        await this.handleRaw(channel, message, attempt);
        return;
      }
      let envelope: EventEnvelope;
      let registration: Registration | undefined;
      try {
        envelope = eventEnvelopeSchema.parse(JSON.parse(message.content.toString('utf8')));
        eventType = qualifiedEventName(envelope.type, envelope.version);
        registration = this.registrations.get(eventType);
        if (registration) {
          envelope = { ...envelope, payload: registration.schema.parse(envelope.payload) };
        } else if (this.fallback) {
          // The fallback still validates catalog payloads it knows about.
          const definition = findEventDefinition(envelope.type, envelope.version);
          if (definition) envelope = { ...envelope, payload: definition.schema.parse(envelope.payload) };
        }
      } catch (error) {
        logger.error({ err: serializeError(error), queue: queue.name }, 'rejecting malformed message');
        await this.deadLetter(channel, message, 'invalid_message', error, attempt, eventType);
        return;
      }

      const handler = registration?.handler ?? this.fallback;
      if (!handler) {
        await this.deadLetter(
          channel,
          message,
          'unhandled_event_type',
          new Error(`No handler for ${eventType}`),
          attempt,
          eventType,
        );
        return;
      }

      const timer = processingDuration.startTimer({ queue: queue.name, event_type: eventType });
      try {
        await withSpan(
          `${queue.name} process ${eventType}`,
          {
            kind: SpanKind.CONSUMER,
            parent: extractTraceContext(headers),
            attributes: {
              'messaging.system': 'rabbitmq',
              'messaging.destination.name': queue.name,
              'messaging.operation.type': 'process',
              'messaging.message.id': envelope.id,
              'messaging.rabbitmq.destination.routing_key': message.fields.routingKey,
              'messaging.message.retry_attempt': attempt,
            },
          },
          () =>
            runWithContext(
              { requestId: envelope.id, correlationId: envelope.correlationId, causationId: envelope.id },
              () =>
                handler({
                  envelope,
                  routingKey: message.fields.routingKey,
                  attempt,
                  redelivered: message.fields.redelivered,
                  headers,
                  raw: message,
                }),
            ),
        );
        timer();
        channel.ack(message);
        consumedTotal.inc({ queue: queue.name, event_type: eventType, outcome: 'success' });
      } catch (error) {
        timer();
        await this.onHandlerError(channel, message, error, attempt, eventType, envelope);
      }
    } catch (error) {
      // Republishing to retry/DLQ failed (broker trouble). Requeue: nothing is lost.
      logger.error(
        { err: serializeError(error), queue: queue.name, eventType },
        'failure handling failed; requeueing',
      );
      try {
        channel.nack(message, false, true);
      } catch {
        // Channel already closed: the broker requeues unacked messages itself.
      }
      consumedTotal.inc({ queue: queue.name, event_type: eventType, outcome: 'requeued' });
    } finally {
      this.inFlight -= 1;
      inFlightMessages.dec({ queue: queue.name });
    }
  }

  private async handleRaw(channel: Channel, message: ConsumeMessage, attempt: number): Promise<void> {
    const { queue, logger } = this.options;
    const eventType = message.properties.type ? String(message.properties.type) : 'raw';
    const timer = processingDuration.startTimer({ queue: queue.name, event_type: eventType });
    try {
      await this.rawHandler?.(message);
      timer();
      channel.ack(message);
      consumedTotal.inc({ queue: queue.name, event_type: eventType, outcome: 'success' });
    } catch (error) {
      timer();
      logger.error({ err: serializeError(error), queue: queue.name, attempt }, 'raw handler failed');
      const envelope = {
        id: String(message.properties.messageId ?? 'unknown'),
        correlationId: String(message.properties.correlationId ?? 'unknown'),
      } as EventEnvelope;
      await this.onHandlerError(channel, message, error, attempt, eventType, envelope);
    }
  }

  private async onHandlerError(
    channel: Channel,
    message: ConsumeMessage,
    error: unknown,
    attempt: number,
    eventType: string,
    envelope: EventEnvelope,
  ): Promise<void> {
    const { queue, logger } = this.options;
    const logFields = {
      err: serializeError(error),
      queue: queue.name,
      eventType,
      messageId: envelope.id,
      correlationId: envelope.correlationId,
      attempt,
    };
    if (error instanceof NonRetryableError) {
      logger.error(logFields, 'handler failed permanently');
      await this.deadLetter(channel, message, 'non_retryable', error, attempt, eventType);
      return;
    }
    if (attempt < queue.retryDelaysMs.length) {
      const nextAttempt = attempt + 1;
      logger.warn(
        { ...logFields, nextAttempt, delayMs: queue.retryDelaysMs[attempt] },
        'handler failed; scheduling retry',
      );
      await this.options.client.publish('', retryQueueName(queue.name, nextAttempt), message.content, {
        ...message.properties,
        headers: {
          ...(message.properties.headers ?? {}),
          [HEADERS.retryAttempt]: nextAttempt,
          [HEADERS.lastError]: describe(error),
          [HEADERS.originalExchange]: headerOr(message, HEADERS.originalExchange, message.fields.exchange),
          [HEADERS.originalRoutingKey]: headerOr(
            message,
            HEADERS.originalRoutingKey,
            message.fields.routingKey,
          ),
        },
      });
      channel.ack(message);
      retriesTotal.inc({ queue: queue.name });
      consumedTotal.inc({ queue: queue.name, event_type: eventType, outcome: 'retry' });
      return;
    }
    if (this.options.onRetriesExhausted === 'requeue') {
      logger.error(logFields, 'retries exhausted; requeueing (archive consumer never drops messages)');
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      channel.nack(message, false, true);
      consumedTotal.inc({ queue: queue.name, event_type: eventType, outcome: 'requeued' });
      return;
    }
    logger.error(logFields, 'retries exhausted; dead-lettering');
    await this.deadLetter(channel, message, 'retries_exhausted', error, attempt, eventType);
  }

  private async deadLetter(
    channel: Channel,
    message: ConsumeMessage,
    reason: DeadLetterReason,
    error: unknown,
    attempt: number,
    eventType: string,
  ): Promise<void> {
    const { queue } = this.options;
    const originalRoutingKey = headerOr(message, HEADERS.originalRoutingKey, message.fields.routingKey);
    await this.options.client.publish(
      DEAD_LETTER_EXCHANGE,
      originalRoutingKey || queue.name,
      message.content,
      {
        ...message.properties,
        headers: {
          ...(message.properties.headers ?? {}),
          [HEADERS.deadLetterReason]: reason,
          [HEADERS.lastError]: describe(error),
          [HEADERS.retryAttempt]: attempt,
          [HEADERS.originalQueue]: queue.name,
          [HEADERS.originalExchange]: headerOr(message, HEADERS.originalExchange, message.fields.exchange),
          [HEADERS.originalRoutingKey]: originalRoutingKey,
        },
      },
    );
    channel.ack(message);
    deadLetteredTotal.inc({ queue: queue.name, reason });
    consumedTotal.inc({ queue: queue.name, event_type: eventType, outcome: 'dead_letter' });
  }

  /** Stops new deliveries, waits for in-flight handlers, then closes the channel. */
  async stop(): Promise<void> {
    this.stopping = true;
    const channel = this.channel;
    if (channel && this.consumerTag) await channel.cancel(this.consumerTag).catch(() => undefined);
    const deadline = Date.now() + (this.options.drainTimeoutMs ?? 10_000);
    while (this.inFlight > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.inFlight > 0) {
      this.options.logger.warn(
        { inFlight: this.inFlight },
        'consumer drain timed out; broker will redeliver unacked messages',
      );
    }
    await channel?.close().catch(() => undefined);
    this.channel = undefined;
  }
}

function headerOr(message: ConsumeMessage, header: string, fallback: string): string {
  const value = message.properties.headers?.[header] as unknown;
  if (typeof value === 'string' && value.length > 0) return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return fallback;
}

/** Error text stored in headers: bounded and single-line. */
function describe(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/\s+/g, ' ').slice(0, 500);
}
