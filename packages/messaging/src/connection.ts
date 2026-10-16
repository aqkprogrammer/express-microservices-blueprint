import type { Logger } from '@emb/logger';
import { serializeError } from '@emb/logger';
import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type Options,
  type RecoveringChannelModel,
} from 'amqplib';
import { connectionUp, publishedTotal } from './metrics.js';

export interface RabbitMQClientOptions {
  url: string;
  logger: Logger;
  connectionName: string;
  publishConfirmTimeoutMs?: number;
}

export type PublishOptions = Options.Publish;

type SetupFn = (model: ChannelModel) => Promise<void>;

/**
 * One AMQP connection per process with automatic recovery (amqplib's built-in
 * exponential backoff). Registered setup functions — topology asserts and
 * consumers — run again after every reconnect. Publishing uses a dedicated
 * confirm channel so `publish` resolves only once the broker has taken
 * responsibility for the message.
 */
export class RabbitMQClient {
  private connection: RecoveringChannelModel | undefined;
  private model: ChannelModel | undefined;
  private confirmChannel: ConfirmChannel | undefined;
  private confirmChannelPromise: Promise<ConfirmChannel> | undefined;
  private readonly setupFns: SetupFn[] = [];
  private connected = false;
  private closing = false;

  constructor(private readonly options: RabbitMQClientOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  /** Registers work to (re)run on every successful connection. */
  onConnected(fn: SetupFn): void {
    this.setupFns.push(fn);
    if (this.model) {
      fn(this.model).catch((error: unknown) => {
        this.options.logger.error({ err: serializeError(error) }, 'rabbitmq setup failed');
      });
    }
  }

  /** Starts connecting in the background; the service can boot while the broker is down. */
  async connect(): Promise<void> {
    const { logger } = this.options;
    this.connection = await amqp.connect(this.options.url, {
      clientProperties: { connection_name: this.options.connectionName },
      recovery: {
        initialDelay: 500,
        maxDelay: 15_000,
        maxRetries: Infinity,
        waitForConnect: false,
        setup: async (model: ChannelModel) => {
          this.model = model;
          this.confirmChannel = undefined;
          this.confirmChannelPromise = undefined;
          for (const fn of this.setupFns) await fn(model);
          this.connected = true;
          connectionUp.set(1);
          logger.info('rabbitmq connected');
        },
      },
    });
    this.connection.on('disconnect', (error: Error) => {
      this.connected = false;
      this.model = undefined;
      this.confirmChannel = undefined;
      this.confirmChannelPromise = undefined;
      connectionUp.set(0);
      if (!this.closing) logger.warn({ err: serializeError(error) }, 'rabbitmq disconnected; recovering');
    });
    this.connection.on('reconnect-scheduled', ({ attempt, delay }: { attempt: number; delay: number }) => {
      logger.info({ attempt, delay }, 'rabbitmq reconnect scheduled');
    });
    this.connection.on('error', (error: Error) => {
      logger.warn({ err: serializeError(error) }, 'rabbitmq error');
    });
  }

  async waitUntilConnected(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for RabbitMQ');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async getConfirmChannel(): Promise<ConfirmChannel> {
    if (this.confirmChannel) return this.confirmChannel;
    const model = this.model;
    if (!model || !this.connected) throw new Error('RabbitMQ is not connected');
    this.confirmChannelPromise ??= model.createConfirmChannel().then((channel) => {
      channel.on('close', () => {
        if (this.confirmChannel === channel) {
          this.confirmChannel = undefined;
          this.confirmChannelPromise = undefined;
        }
      });
      channel.on('error', (error: Error) => {
        this.options.logger.warn({ err: serializeError(error) }, 'publisher channel error');
      });
      this.confirmChannel = channel;
      return channel;
    });
    try {
      return await this.confirmChannelPromise;
    } catch (error) {
      this.confirmChannelPromise = undefined;
      throw error;
    }
  }

  /**
   * Publishes a persistent message and waits for the broker confirm. Rejects on
   * nack, channel failure, disconnection or timeout — callers (the outbox relay,
   * retry scheduling) treat a rejection as "not published" and try again.
   */
  async publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: PublishOptions = {},
  ): Promise<void> {
    try {
      const channel = await this.getConfirmChannel();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for publisher confirm'));
        }, this.options.publishConfirmTimeoutMs ?? 5_000);
        channel.publish(
          exchange,
          routingKey,
          content,
          { persistent: true, contentType: 'application/json', ...options },
          (error: unknown) => {
            clearTimeout(timer);
            if (error) reject(error instanceof Error ? error : new Error('Message was nacked by the broker'));
            else resolve();
          },
        );
      });
      publishedTotal.inc({ exchange: exchange || '(default)', outcome: 'confirmed' });
    } catch (error) {
      publishedTotal.inc({ exchange: exchange || '(default)', outcome: 'failed' });
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    connectionUp.set(0);
    await this.connection?.close().catch(() => undefined);
  }

  healthCheck() {
    return {
      name: 'rabbitmq',
      critical: true,
      check: () => (this.connected ? Promise.resolve() : Promise.reject(new Error('not connected'))),
    };
  }
}
