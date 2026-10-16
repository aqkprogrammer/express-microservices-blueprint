import { z } from 'zod';
import { amountCentsSchema, currencySchema, roleSchema } from './common.js';
import { qualifiedEventName } from './envelope.js';

export interface EventDefinition<TName extends string = string, TSchema extends z.ZodType = z.ZodType> {
  /** Event type without version, e.g. `OrderCreated`. */
  type: TName;
  version: number;
  /** Topic-exchange routing key: `<domain>.<event>.v<version>`. */
  routingKey: string;
  producer: string;
  description: string;
  schema: TSchema;
}

function defineEvent<const TName extends string, TSchema extends z.ZodType>(
  definition: EventDefinition<TName, TSchema>,
): EventDefinition<TName, TSchema> {
  return definition;
}

const orderLineSchema = z.object({
  productId: z.uuid(),
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPriceCents: amountCentsSchema,
});

const reservationLineSchema = z.object({ productId: z.uuid(), quantity: z.number().int().positive() });

export const ORDER_CANCELLATION_REASONS = [
  'out_of_stock',
  'payment_failed',
  'reservation_expired',
  'inventory_timeout',
  'customer_requested',
  'admin_requested',
] as const;

/**
 * Versioned event catalog. Payload schemas are additive-only within a version:
 * new optional fields are allowed, while removing or retyping a field requires
 * a new version (e.g. `OrderCreated.v2`) published alongside v1 until every
 * consumer has migrated. Contract tests in `tests/contract` pin v1 fixtures.
 */
export const events = {
  // ── auth-service ────────────────────────────────────────────────────────────
  UserRegistered: defineEvent({
    type: 'UserRegistered',
    version: 1,
    routingKey: 'auth.user-registered.v1',
    producer: 'auth-service',
    description: 'A new account was created. Consumers create profiles and recipient records.',
    schema: z.object({
      userId: z.uuid(),
      email: z.email(),
      displayName: z.string().min(1).max(100),
      roles: z.array(roleSchema).min(1),
      registeredAt: z.iso.datetime({ offset: true }),
    }),
  }),
  UserLoggedIn: defineEvent({
    type: 'UserLoggedIn',
    version: 1,
    routingKey: 'auth.user-logged-in.v1',
    producer: 'auth-service',
    description: 'Security audit: successful login that opened a refresh-token session.',
    schema: z.object({ userId: z.uuid(), sessionId: z.uuid() }),
  }),
  UserLoggedOut: defineEvent({
    type: 'UserLoggedOut',
    version: 1,
    routingKey: 'auth.user-logged-out.v1',
    producer: 'auth-service',
    description: 'Security audit: a refresh-token session was revoked by its owner.',
    schema: z.object({ userId: z.uuid(), sessionId: z.uuid() }),
  }),
  LoginFailed: defineEvent({
    type: 'LoginFailed',
    version: 1,
    routingKey: 'auth.login-failed.v1',
    producer: 'auth-service',
    description: 'Security audit: failed login. Never contains the submitted email or password.',
    schema: z.object({
      userId: z.uuid().nullable(),
      reason: z.enum(['invalid_credentials', 'account_inactive']),
    }),
  }),
  RefreshTokenReuseDetected: defineEvent({
    type: 'RefreshTokenReuseDetected',
    version: 1,
    routingKey: 'auth.refresh-token-reuse-detected.v1',
    producer: 'auth-service',
    description: 'A rotated refresh token was replayed; the whole session family was revoked.',
    schema: z.object({ userId: z.uuid(), sessionId: z.uuid() }),
  }),
  PasswordResetRequested: defineEvent({
    type: 'PasswordResetRequested',
    version: 1,
    routingKey: 'auth.password-reset-requested.v1',
    producer: 'auth-service',
    description: 'Security audit: a reset token was issued (the token itself is never in this event).',
    schema: z.object({ userId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) }),
  }),
  PasswordChanged: defineEvent({
    type: 'PasswordChanged',
    version: 1,
    routingKey: 'auth.password-changed.v1',
    producer: 'auth-service',
    description: 'Password changed; all sessions for the user were revoked.',
    schema: z.object({ userId: z.uuid(), method: z.enum(['reset']) }),
  }),

  // ── user-service ────────────────────────────────────────────────────────────
  UserProfileUpdated: defineEvent({
    type: 'UserProfileUpdated',
    version: 1,
    routingKey: 'user.profile-updated.v1',
    producer: 'user-service',
    description: 'Profile fields changed. Notification service refreshes its recipient copy.',
    schema: z.object({ userId: z.uuid(), email: z.email(), displayName: z.string() }),
  }),
  UserStatusChanged: defineEvent({
    type: 'UserStatusChanged',
    version: 1,
    routingKey: 'user.status-changed.v1',
    producer: 'user-service',
    description: 'Account status changed. Auth service blocks logins and revokes sessions when inactive.',
    schema: z.object({
      userId: z.uuid(),
      status: z.enum(['active', 'suspended', 'closed']),
      previousStatus: z.enum(['active', 'suspended', 'closed']),
      reason: z.string().max(500).optional(),
      changedBy: z.uuid(),
    }),
  }),

  // ── product-service ─────────────────────────────────────────────────────────
  ProductCreated: defineEvent({
    type: 'ProductCreated',
    version: 1,
    routingKey: 'product.created.v1',
    producer: 'product-service',
    description: 'A product was added to the catalog. Inventory provisions a stock record.',
    schema: z.object({
      productId: z.uuid(),
      sku: z.string(),
      name: z.string(),
      priceCents: amountCentsSchema,
      currency: currencySchema,
      status: z.enum(['draft', 'active', 'discontinued']),
    }),
  }),
  ProductUpdated: defineEvent({
    type: 'ProductUpdated',
    version: 1,
    routingKey: 'product.updated.v1',
    producer: 'product-service',
    description: 'Catalog data (name, price, status) changed.',
    schema: z.object({
      productId: z.uuid(),
      sku: z.string(),
      name: z.string(),
      priceCents: amountCentsSchema,
      currency: currencySchema,
      status: z.enum(['draft', 'active', 'discontinued']),
      changedFields: z.array(z.string()),
    }),
  }),

  // ── inventory-service ───────────────────────────────────────────────────────
  InventoryReserved: defineEvent({
    type: 'InventoryReserved',
    version: 1,
    routingKey: 'inventory.reserved.v1',
    producer: 'inventory-service',
    description: 'Stock for every order line was reserved until `expiresAt`.',
    schema: z.object({
      orderId: z.uuid(),
      reservationId: z.uuid(),
      expiresAt: z.iso.datetime({ offset: true }),
      lines: z.array(reservationLineSchema).min(1),
    }),
  }),
  InventoryReservationFailed: defineEvent({
    type: 'InventoryReservationFailed',
    version: 1,
    routingKey: 'inventory.reservation-failed.v1',
    producer: 'inventory-service',
    description: 'At least one line could not be reserved; nothing was reserved.',
    schema: z.object({
      orderId: z.uuid(),
      reason: z.enum(['insufficient_stock', 'unknown_product']),
      unavailable: z.array(
        z.object({ productId: z.uuid(), requested: z.number().int(), available: z.number().int() }),
      ),
    }),
  }),
  InventoryReleased: defineEvent({
    type: 'InventoryReleased',
    version: 1,
    routingKey: 'inventory.released.v1',
    producer: 'inventory-service',
    description: 'Compensation: reserved (or committed) stock was returned to availability.',
    schema: z.object({
      orderId: z.uuid(),
      reservationId: z.uuid(),
      reason: z.enum(['order_cancelled', 'expired']),
    }),
  }),
  InventoryReservationExpired: defineEvent({
    type: 'InventoryReservationExpired',
    version: 1,
    routingKey: 'inventory.reservation-expired.v1',
    producer: 'inventory-service',
    description: 'A reservation reached its TTL before the order was confirmed and was released.',
    schema: z.object({ orderId: z.uuid(), reservationId: z.uuid() }),
  }),
  InventoryCommitted: defineEvent({
    type: 'InventoryCommitted',
    version: 1,
    routingKey: 'inventory.committed.v1',
    producer: 'inventory-service',
    description: 'Reserved stock was deducted from on-hand after order confirmation.',
    schema: z.object({ orderId: z.uuid(), reservationId: z.uuid() }),
  }),
  InventoryCommitFailed: defineEvent({
    type: 'InventoryCommitFailed',
    version: 1,
    routingKey: 'inventory.commit-failed.v1',
    producer: 'inventory-service',
    description:
      'A confirmed order could not be fulfilled from stock (e.g. reservation expired and stock is gone).',
    schema: z.object({ orderId: z.uuid(), reason: z.string() }),
  }),
  InventoryStockChanged: defineEvent({
    type: 'InventoryStockChanged',
    version: 1,
    routingKey: 'inventory.stock-changed.v1',
    producer: 'inventory-service',
    description: 'Availability for a product changed. Product service updates its read model.',
    schema: z.object({
      productId: z.uuid(),
      onHand: z.number().int().nonnegative(),
      reserved: z.number().int().nonnegative(),
      available: z.number().int().nonnegative(),
    }),
  }),

  // ── order-service ───────────────────────────────────────────────────────────
  OrderCreated: defineEvent({
    type: 'OrderCreated',
    version: 1,
    routingKey: 'order.created.v1',
    producer: 'order-service',
    description: 'Saga start: a pending order was persisted with price snapshots.',
    schema: z.object({
      orderId: z.uuid(),
      customerId: z.uuid(),
      currency: currencySchema,
      totalCents: amountCentsSchema,
      lines: z.array(orderLineSchema).min(1),
    }),
  }),
  PaymentAuthorizationRequested: defineEvent({
    type: 'PaymentAuthorizationRequested',
    version: 1,
    routingKey: 'order.payment-authorization-requested.v1',
    producer: 'order-service',
    description: 'Saga step: the orchestrator asks the payment service to authorize the order total.',
    schema: z.object({
      orderId: z.uuid(),
      customerId: z.uuid(),
      amountCents: amountCentsSchema,
      currency: currencySchema,
      paymentMethodToken: z.string().min(1).max(64),
      attempt: z.number().int().positive(),
    }),
  }),
  OrderConfirmed: defineEvent({
    type: 'OrderConfirmed',
    version: 1,
    routingKey: 'order.confirmed.v1',
    producer: 'order-service',
    description: 'Saga success: stock reserved and payment authorized.',
    schema: z.object({
      orderId: z.uuid(),
      customerId: z.uuid(),
      currency: currencySchema,
      totalCents: amountCentsSchema,
      paymentId: z.uuid(),
      lines: z.array(orderLineSchema).min(1),
    }),
  }),
  OrderCancelled: defineEvent({
    type: 'OrderCancelled',
    version: 1,
    routingKey: 'order.cancelled.v1',
    producer: 'order-service',
    description: 'Terminal failure or customer cancellation. Triggers inventory/payment compensation.',
    schema: z.object({
      orderId: z.uuid(),
      customerId: z.uuid(),
      reason: z.enum(ORDER_CANCELLATION_REASONS),
      previousStatus: z.string(),
      cancelledBy: z.enum(['customer', 'system', 'admin']),
    }),
  }),
  OrderRequiresReview: defineEvent({
    type: 'OrderRequiresReview',
    version: 1,
    routingKey: 'order.requires-review.v1',
    producer: 'order-service',
    description:
      'The saga could not reach a safe terminal state automatically (e.g. unknown payment outcome).',
    schema: z.object({ orderId: z.uuid(), customerId: z.uuid(), reason: z.string() }),
  }),

  // ── payment-service ─────────────────────────────────────────────────────────
  PaymentAuthorized: defineEvent({
    type: 'PaymentAuthorized',
    version: 1,
    routingKey: 'payment.authorized.v1',
    producer: 'payment-service',
    description: 'The simulator authorized (held) the amount.',
    schema: z.object({
      paymentId: z.uuid(),
      orderId: z.uuid(),
      amountCents: amountCentsSchema,
      currency: currencySchema,
    }),
  }),
  PaymentFailed: defineEvent({
    type: 'PaymentFailed',
    version: 1,
    routingKey: 'payment.failed.v1',
    producer: 'payment-service',
    description: 'Authorization was definitively declined.',
    schema: z.object({
      paymentId: z.uuid(),
      orderId: z.uuid(),
      reason: z.enum(['declined', 'insufficient_funds', 'provider_error']),
    }),
  }),
  PaymentCaptured: defineEvent({
    type: 'PaymentCaptured',
    version: 1,
    routingKey: 'payment.captured.v1',
    producer: 'payment-service',
    description: 'Authorized funds were captured after order confirmation.',
    schema: z.object({ paymentId: z.uuid(), orderId: z.uuid(), amountCents: amountCentsSchema }),
  }),
  PaymentVoided: defineEvent({
    type: 'PaymentVoided',
    version: 1,
    routingKey: 'payment.voided.v1',
    producer: 'payment-service',
    description: 'Compensation: an authorization was released without capture.',
    schema: z.object({ paymentId: z.uuid(), orderId: z.uuid() }),
  }),
  PaymentRefunded: defineEvent({
    type: 'PaymentRefunded',
    version: 1,
    routingKey: 'payment.refunded.v1',
    producer: 'payment-service',
    description: 'Compensation: captured funds were refunded.',
    schema: z.object({
      paymentId: z.uuid(),
      orderId: z.uuid(),
      customerId: z.uuid(),
      amountCents: amountCentsSchema,
      currency: currencySchema,
    }),
  }),

  // ── notification-service ────────────────────────────────────────────────────
  NotificationRequested: defineEvent({
    type: 'NotificationRequested',
    version: 1,
    routingKey: 'notification.requested.v1',
    producer: 'any',
    description:
      'Generic request to notify a user with a named template. Keys in `sensitiveDataKeys` are scrubbed after delivery.',
    schema: z.object({
      recipientUserId: z.uuid(),
      template: z.string().regex(/^[a-z0-9-]+$/),
      data: z.record(z.string(), z.union([z.string(), z.number()])),
      sensitiveDataKeys: z.array(z.string()).default([]),
    }),
  }),
  NotificationSent: defineEvent({
    type: 'NotificationSent',
    version: 1,
    routingKey: 'notification.sent.v1',
    producer: 'notification-service',
    description: 'A notification was handed to the email transport.',
    schema: z.object({ notificationId: z.uuid(), template: z.string(), recipientUserId: z.uuid() }),
  }),
  NotificationDeliveryFailed: defineEvent({
    type: 'NotificationDeliveryFailed',
    version: 1,
    routingKey: 'notification.delivery-failed.v1',
    producer: 'notification-service',
    description: 'Delivery failed permanently after all retries.',
    schema: z.object({
      notificationId: z.uuid(),
      template: z.string(),
      recipientUserId: z.uuid(),
      attempts: z.number().int(),
    }),
  }),
} as const;

export type EventCatalog = typeof events;
export type EventType = keyof EventCatalog;
export type EventPayload<T extends EventType> = z.output<EventCatalog[T]['schema']>;
export type EventPayloadInput<T extends EventType> = z.input<EventCatalog[T]['schema']>;

const byQualifiedName = new Map<string, EventDefinition>(
  Object.values(events).map((definition) => [
    qualifiedEventName(definition.type, definition.version),
    definition,
  ]),
);

/** Looks up a definition by `type` + `version` (used by consumers to validate payloads). */
export function findEventDefinition(type: string, version: number): EventDefinition | undefined {
  return byQualifiedName.get(qualifiedEventName(type, version));
}

export const allEventDefinitions = (): EventDefinition[] => [...byQualifiedName.values()];
