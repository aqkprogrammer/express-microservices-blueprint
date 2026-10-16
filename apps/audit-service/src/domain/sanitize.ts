/**
 * Field allow-list for audit details. Anything not listed — emails, names,
 * free-text, tokens, URLs, payment method tokens — is dropped, so the audit
 * store never accumulates secrets or unnecessary personal data.
 */
const ALLOWED_FIELDS = new Set([
  'userId',
  'sessionId',
  'orderId',
  'paymentId',
  'productId',
  'reservationId',
  'notificationId',
  'recipientUserId',
  'customerId',
  'sku',
  'status',
  'previousStatus',
  'reason',
  'method',
  'roles',
  'changedBy',
  'changedFields',
  'cancelledBy',
  'amountCents',
  'currency',
  'template',
  'attempts',
  'expiresAt',
]);

/** Free-text reasons are bounded; values that look like credentials are refused outright. */
const SUSPICIOUS = /(bearer\s|eyJ[A-Za-z0-9_-]{10,}|password|token=|secret)/i;

export function sanitizeDetails(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) return {};
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (typeof value === 'string') {
      if (SUSPICIOUS.test(value)) continue;
      details[key] = value.slice(0, 200);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      details[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      details[key] = value.slice(0, 20);
    }
  }
  return details;
}

const SECURITY_EVENTS = new Set([
  'UserRegistered',
  'UserLoggedIn',
  'UserLoggedOut',
  'LoginFailed',
  'RefreshTokenReuseDetected',
  'PasswordResetRequested',
  'PasswordChanged',
  'UserStatusChanged',
]);

export function categorize(eventType: string): 'security' | 'business' | 'operations' {
  if (SECURITY_EVENTS.has(eventType)) return 'security';
  if (eventType === 'NotificationDeliveryFailed' || eventType === 'InventoryCommitFailed')
    return 'operations';
  return 'business';
}

/** Who performed the action, when the event says so. */
export function actorOf(payload: Record<string, unknown>): string | undefined {
  for (const key of ['changedBy', 'userId', 'customerId']) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
