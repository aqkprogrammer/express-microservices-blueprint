/**
 * Integrity constraints Prisma's schema language cannot express. Each service's
 * initial migration includes the equivalent statements; exported for tests.
 */
export const OUTBOX_MIGRATION_SQL = `
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_status_check CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED'));
`;
