import type { Logger } from '@emb/logger';
import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Abstraction over email delivery so the provider can change without touching business logic. */
export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<{ messageId: string }>;
  verify?(): Promise<void>;
}

export class SmtpTransport implements EmailTransport {
  readonly name = 'smtp';
  private readonly transporter;

  constructor(options: {
    host: string;
    port: number;
    secure: boolean;
    user?: string | undefined;
    password?: string | undefined;
    from: string;
  }) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
    this.from = options.from;
  }

  private readonly from: string;

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const info = await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    return { messageId: info.messageId };
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }
}

/** Development transport: logs that a message was "sent" without printing its body or full address. */
export class ConsoleTransport implements EmailTransport {
  readonly name = 'console';
  constructor(private readonly logger: Logger) {}

  send(message: EmailMessage): Promise<{ messageId: string }> {
    this.logger.info({ to: redactEmail(message.to), subject: message.subject }, 'email (console transport)');
    return Promise.resolve({ messageId: `console-${Date.now()}` });
  }
}

export class SimulatedDeliveryError extends Error {
  constructor() {
    super('Simulated SMTP rejection (SIMULATE_FAILURE_DOMAIN)');
    this.name = 'SimulatedDeliveryError';
  }
}

/** Wraps a transport and fails deliveries to one domain — used to demo retries and the DLQ. */
export class FailureSimulatingTransport implements EmailTransport {
  readonly name: string;
  constructor(
    private readonly inner: EmailTransport,
    private readonly failingDomain: string,
  ) {
    this.name = `${inner.name}+failure-simulation`;
  }

  send(message: EmailMessage): Promise<{ messageId: string }> {
    if (message.to.toLowerCase().endsWith(`@${this.failingDomain.toLowerCase()}`))
      return Promise.reject(new SimulatedDeliveryError());
    return this.inner.send(message);
  }
}

export function redactEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
