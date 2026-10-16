import { z } from 'zod';

/**
 * Scheduled maintenance tasks. The worker publishes these on a schedule (with
 * a Redis lock so only one worker replica schedules) and the owning service
 * performs the work against its own database.
 */
export const MAINTENANCE_TASKS = {
  'inventory.expire-reservations': {
    routingKey: 'maintenance.inventory.expire-reservations',
    intervalMs: 15_000,
  },
  'order.check-saga-timeouts': { routingKey: 'maintenance.order.check-saga-timeouts', intervalMs: 10_000 },
  'payment.reconcile': { routingKey: 'maintenance.payment.reconcile', intervalMs: 15_000 },
  'audit.apply-retention': { routingKey: 'maintenance.audit.apply-retention', intervalMs: 3_600_000 },
  'all.cleanup': { routingKey: 'maintenance.all.cleanup', intervalMs: 3_600_000 },
} as const;

export type MaintenanceTask = keyof typeof MAINTENANCE_TASKS;
export const maintenanceTaskSchema = z.enum(
  Object.keys(MAINTENANCE_TASKS) as [MaintenanceTask, ...MaintenanceTask[]],
);

export const MAINTENANCE_EVENT_TYPE = 'MaintenanceRequested';
export const maintenanceRequestedSchema = z.object({
  task: maintenanceTaskSchema,
  scheduledAt: z.iso.datetime({ offset: true }),
});
export type MaintenanceRequested = z.infer<typeof maintenanceRequestedSchema>;
