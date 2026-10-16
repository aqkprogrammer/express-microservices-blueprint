import type { Server } from 'node:http';
import type { Logger } from '@emb/logger';
import { serializeError } from '@emb/logger';
import type { Express } from 'express';

export interface ShutdownHook {
  name: string;
  close: () => Promise<void>;
}

export interface ServiceRuntimeOptions {
  logger: Logger;
  /** Hard deadline for the whole shutdown sequence. */
  shutdownTimeoutMs?: number;
  /**
   * Delay between failing readiness and closing the listener, giving load
   * balancers / Kubernetes endpoints time to stop routing new traffic here.
   */
  drainDelayMs?: number;
  exit?: (code: number) => void;
}

/**
 * Owns process lifecycle: starts the HTTP listener, installs signal handlers
 * and runs registered shutdown hooks in reverse registration order (so
 * consumers stop before the connections they use are closed).
 */
export class ServiceRuntime {
  private readonly hooks: ShutdownHook[] = [];
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private server: Server | undefined;

  constructor(private readonly options: ServiceRuntimeOptions) {}

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  onShutdown(name: string, close: () => Promise<void>): void {
    this.hooks.push({ name, close });
  }

  async listen(app: Express, port: number, host = '0.0.0.0'): Promise<Server> {
    const server = await new Promise<Server>((resolve, reject) => {
      const listening = app.listen(port, host, (error?: Error) => {
        if (error) reject(error);
        else resolve(listening);
      });
    });
    // Keep-alive must outlive typical proxy idle timeouts to avoid racing resets.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 30_000;
    this.server = server;
    this.options.logger.info({ port }, 'http server listening');
    return server;
  }

  installSignalHandlers(): void {
    process.once('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.once('SIGINT', () => void this.shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      this.options.logger.fatal({ err: serializeError(reason) }, 'unhandled promise rejection');
      void this.shutdown('unhandledRejection', 1);
    });
    process.on('uncaughtException', (error) => {
      this.options.logger.fatal({ err: serializeError(error) }, 'uncaught exception');
      void this.shutdown('uncaughtException', 1);
    });
  }

  shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const { logger } = this.options;
    const exit = this.options.exit ?? ((code: number) => process.exit(code));
    logger.info({ reason }, 'shutdown started');

    const deadline = setTimeout(() => {
      logger.error({ timeoutMs: this.options.shutdownTimeoutMs }, 'shutdown timed out, forcing exit');
      exit(1);
    }, this.options.shutdownTimeoutMs ?? 15_000);
    deadline.unref();

    this.shutdownPromise = (async () => {
      let code = exitCode;
      if (this.options.drainDelayMs)
        await new Promise((resolve) => setTimeout(resolve, this.options.drainDelayMs));
      if (this.server) await this.closeServer(this.server);
      for (const hook of [...this.hooks].reverse()) {
        try {
          await hook.close();
          logger.info({ hook: hook.name }, 'shutdown hook completed');
        } catch (error) {
          code = 1;
          logger.error({ hook: hook.name, err: serializeError(error) }, 'shutdown hook failed');
        }
      }
      clearTimeout(deadline);
      logger.info({ exitCode: code }, 'shutdown complete');
      logger.flush();
      exit(code);
    })();
    return this.shutdownPromise;
  }

  private closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
      // Idle keep-alive sockets would otherwise hold the server open.
      server.closeIdleConnections();
      setTimeout(() => {
        server.closeAllConnections();
      }, 10_000).unref();
    });
  }
}
