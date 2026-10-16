import { events } from './events.js';
import { MAINTENANCE_TASKS } from './maintenance.js';

/** Topic exchange for all domain events. */
export const EVENTS_EXCHANGE = 'domain.events';
/** Topic exchange for scheduled maintenance commands published by the worker. */
export const MAINTENANCE_EXCHANGE = 'maintenance.commands';
/** Topic exchange receiving messages that exhausted retries or were rejected as poison. */
export const DEAD_LETTER_EXCHANGE = 'dead-letters';

export interface QueueBinding {
  exchange: string;
  routingKey: string;
}

export interface ConsumerQueueDefinition {
  name: string;
  owner: string;
  bindings: QueueBinding[];
  /** Delays (ms) for successive retries; length = number of retries before dead-lettering. */
  retryDelaysMs: number[];
  /** Quorum-queue safety net for messages that crash the consumer before ack/nack. */
  deliveryLimit: number;
}

const eventBinding = (definition: { routingKey: string }): QueueBinding => ({
  exchange: EVENTS_EXCHANGE,
  routingKey: definition.routingKey,
});
const maintenanceBinding = (routingKey: string): QueueBinding => ({
  exchange: MAINTENANCE_EXCHANGE,
  routingKey,
});

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
const cleanup = maintenanceBinding(MAINTENANCE_TASKS['all.cleanup'].routingKey);

/**
 * The single source of truth for queues and bindings. Services assert their
 * own queues at startup, and `scripts/generate-rabbitmq-definitions.mjs`
 * renders this into `infrastructure/rabbitmq/definitions.json` so the broker
 * has every queue before any producer publishes.
 */
export const CONSUMER_QUEUES = {
  auth: {
    name: 'auth-service.events',
    owner: 'auth-service',
    bindings: [eventBinding(events.UserStatusChanged), cleanup],
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    deliveryLimit: 10,
  },
  user: {
    name: 'user-service.events',
    owner: 'user-service',
    bindings: [eventBinding(events.UserRegistered), cleanup],
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    deliveryLimit: 10,
  },
  product: {
    name: 'product-service.events',
    owner: 'product-service',
    bindings: [eventBinding(events.InventoryStockChanged), cleanup],
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    deliveryLimit: 10,
  },
  inventory: {
    name: 'inventory-service.events',
    owner: 'inventory-service',
    bindings: [
      eventBinding(events.ProductCreated),
      eventBinding(events.OrderCreated),
      eventBinding(events.OrderConfirmed),
      eventBinding(events.OrderCancelled),
      maintenanceBinding(MAINTENANCE_TASKS['inventory.expire-reservations'].routingKey),
      cleanup,
    ],
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    deliveryLimit: 10,
  },
  order: {
    name: 'order-service.events',
    owner: 'order-service',
    bindings: [
      eventBinding(events.InventoryReserved),
      eventBinding(events.InventoryReservationFailed),
      eventBinding(events.InventoryReservationExpired),
      eventBinding(events.InventoryCommitFailed),
      eventBinding(events.PaymentAuthorized),
      eventBinding(events.PaymentFailed),
      maintenanceBinding(MAINTENANCE_TASKS['order.check-saga-timeouts'].routingKey),
      cleanup,
    ],
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    deliveryLimit: 10,
  },
  payment: {
    name: 'payment-service.events',
    owner: 'payment-service',
    bindings: [
      eventBinding(events.PaymentAuthorizationRequested),
      eventBinding(events.OrderConfirmed),
      eventBinding(events.OrderCancelled),
      maintenanceBinding(MAINTENANCE_TASKS['payment.reconcile'].routingKey),
      cleanup,
    ],
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    deliveryLimit: 10,
  },
  notification: {
    name: 'notification-service.events',
    owner: 'notification-service',
    bindings: [
      eventBinding(events.UserRegistered),
      eventBinding(events.UserProfileUpdated),
      eventBinding(events.OrderConfirmed),
      eventBinding(events.OrderCancelled),
      eventBinding(events.OrderRequiresReview),
      eventBinding(events.PaymentRefunded),
      eventBinding(events.NotificationRequested),
      cleanup,
    ],
    // Email providers recover slowly, so notifications back off for longer.
    retryDelaysMs: [2_000, 10_000, 30_000],
    deliveryLimit: 10,
  },
  audit: {
    name: 'audit-service.events',
    owner: 'audit-service',
    bindings: [
      { exchange: EVENTS_EXCHANGE, routingKey: 'auth.#' },
      { exchange: EVENTS_EXCHANGE, routingKey: 'user.#' },
      { exchange: EVENTS_EXCHANGE, routingKey: 'product.#' },
      { exchange: EVENTS_EXCHANGE, routingKey: 'payment.#' },
      eventBinding(events.OrderConfirmed),
      eventBinding(events.OrderCancelled),
      eventBinding(events.OrderRequiresReview),
      eventBinding(events.InventoryCommitFailed),
      eventBinding(events.NotificationDeliveryFailed),
      maintenanceBinding(MAINTENANCE_TASKS['audit.apply-retention'].routingKey),
      cleanup,
    ],
    retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
    deliveryLimit: 10,
  },
  deadLetters: {
    name: 'worker.dead-letters',
    owner: 'worker',
    bindings: [{ exchange: DEAD_LETTER_EXCHANGE, routingKey: '#' }],
    retryDelaysMs: [1_000, 5_000],
    // -1 = unlimited: the archive must never drop a message because it was redelivered often.
    deliveryLimit: -1,
  },
} as const satisfies Record<string, ConsumerQueueDefinition>;

export const retryQueueName = (queue: string, attempt: number) => `${queue}.retry.${attempt}`;

/** Arguments shared by producers' asserts, consumers' asserts and definitions.json — they must match exactly. */
export function mainQueueArguments(queue: ConsumerQueueDefinition): Record<string, string | number> {
  const args: Record<string, string | number> = {
    'x-queue-type': 'quorum',
    'x-delivery-limit': queue.deliveryLimit,
  };
  // The dead-letter archive itself must not dead-letter into itself.
  if (queue.name !== CONSUMER_QUEUES.deadLetters.name) args['x-dead-letter-exchange'] = DEAD_LETTER_EXCHANGE;
  return args;
}

export function retryQueueArguments(
  queue: ConsumerQueueDefinition,
  attempt: number,
): Record<string, string | number> {
  const delay = queue.retryDelaysMs[attempt - 1];
  if (delay === undefined) throw new Error(`No retry tier ${attempt} for ${queue.name}`);
  return {
    'x-queue-type': 'classic',
    'x-message-ttl': delay,
    // Expired messages go back to the main queue via the default exchange.
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': queue.name,
  };
}
