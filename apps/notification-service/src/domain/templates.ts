/**
 * Default templates, inserted when missing at startup. Admins can edit them
 * through the API; edits are versioned and never overwritten by defaults.
 * Templates are plain text with `{{placeholder}}` variables.
 */
export const DEFAULT_TEMPLATES: Record<string, { subject: string; bodyText: string }> = {
  welcome: {
    subject: 'Welcome, {{displayName}}!',
    bodyText: 'Hi {{displayName}},\n\nYour account is ready. Happy shopping!\n\n— The Blueprint Store',
  },
  'order-confirmed': {
    subject: 'Order {{orderReference}} confirmed',
    bodyText:
      'Hi {{displayName}},\n\nGood news — order {{orderReference}} ({{itemCount}} item(s), {{total}}) is confirmed and your payment was authorized.\n\n— The Blueprint Store',
  },
  'order-cancelled': {
    subject: 'Order {{orderReference}} was cancelled',
    bodyText:
      'Hi {{displayName}},\n\nOrder {{orderReference}} was cancelled: {{reason}}.\nAny reserved stock has been released and any payment hold or charge will be reversed.\n\n— The Blueprint Store',
  },
  'order-under-review': {
    subject: 'Order {{orderReference}} needs a quick review',
    bodyText:
      'Hi {{displayName}},\n\nWe could not automatically confirm order {{orderReference}}. Our team is reviewing it and will be in touch. You will not be charged twice.\n\n— The Blueprint Store',
  },
  'payment-refunded': {
    subject: 'Refund issued for order {{orderReference}}',
    bodyText:
      'Hi {{displayName}},\n\nWe refunded {{amount}} for order {{orderReference}}.\n\n— The Blueprint Store',
  },
  'password-reset': {
    subject: 'Reset your password',
    bodyText:
      'Hi {{displayName}},\n\nUse this link within {{expiresInMinutes}} minutes to choose a new password:\n{{resetUrl}}\n\nIf you did not request this, you can ignore this email.\n\n— The Blueprint Store',
  },
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

export class MissingTemplateVariableError extends Error {
  constructor(public readonly variable: string) {
    super(`Template variable "${variable}" was not provided`);
    this.name = 'MissingTemplateVariableError';
  }
}

export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

/** Substitutes `{{name}}` placeholders; a missing variable is an error, not an empty string. */
export function render(template: string, data: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = data[name];
    if (value === undefined) throw new MissingTemplateVariableError(name);
    // Strip CR/LF from values so data can never inject extra header lines into subjects.
    return String(value).replace(/[\r\n]+/g, ' ');
  });
}

export const formatMoney = (amountCents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountCents / 100);

export const orderReference = (orderId: string) => orderId.slice(0, 8).toUpperCase();

const CANCELLATION_TEXT: Record<string, string> = {
  out_of_stock: 'some items were out of stock',
  payment_failed: 'the payment was declined',
  reservation_expired: 'the stock reservation expired before payment completed',
  inventory_timeout: 'we could not confirm stock in time',
  customer_requested: 'you requested the cancellation',
  admin_requested: 'it was cancelled by our support team',
};
export const cancellationText = (reason: string) => CANCELLATION_TEXT[reason] ?? 'it could not be completed';
