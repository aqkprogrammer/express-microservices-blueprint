# Data retention

What is deleted automatically, when, and by whom. Scheduled tasks are published by the worker on `maintenance.commands` and executed by the owning service against its own database ([event catalog](../development/event-catalog.md#maintenance-commands)).

## Automated retention

| Data                                                | Table (database)                                      | Retention                                         | Mechanism                                                                                                                          | Configurable                    |
| --------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Published outbox events                             | `outbox_events` (every service DB except `worker_db`) | **72 h** after publication; **24 h** in `auth_db` | `all.cleanup`, hourly. Only `PUBLISHED` rows are deleted; pending rows are never deleted                                           | Code (`cleanupTask` options)    |
| Processed-message markers                           | `processed_messages`                                  | **7 days** (168 h)                                | `all.cleanup`, hourly                                                                                                              | Code                            |
| Payment idempotency records (stored REST responses) | `idempotency_records` (`payment_db`)                  | **24 h** after creation                           | `all.cleanup` in payment-service                                                                                                   | Code                            |
| Expired refresh and password-reset tokens           | `refresh_tokens`, `password_reset_tokens` (`auth_db`) | Deleted **1 day after expiry**                    | `all.cleanup` in auth-service                                                                                                      | Code                            |
| Audit records                                       | `audit_records` (`audit_db`)                          | **365 days**                                      | `audit.apply-retention`, hourly                                                                                                    | `AUDIT_RETENTION_DAYS` (1–3650) |
| Scheduler job history                               | `job_runs` (`worker_db`)                              | **7 days**                                        | Hourly timer in the worker                                                                                                         | `JOB_RUN_RETENTION_DAYS`        |
| Sensitive notification data                         | `notifications.data` (`notification_db`)              | Until the notification is `SENT` or `FAILED`      | Keys listed in `sensitiveDataKeys` (e.g. `resetUrl` of the password-reset email) are replaced with `[scrubbed]` on the final state | Per event                       |

The audit table is append-only (a trigger blocks `UPDATE`); retention uses `DELETE`.

## Retained until manually removed

| Data                                            | Notes                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dead letters (`dead_letters`, `worker_db`)      | Kept with status `ARCHIVED`, `REPLAYED` or `DISCARDED`; message bodies may contain personal data (e.g. emails in `UserRegistered`). No automatic deletion is implemented — define a policy and delete resolved records periodically. |
| Accounts, profiles, recipients                  | No automatic deletion. Account closure (`status: closed`) blocks login but keeps the records.                                                                                                                                        |
| Orders, order lines, status history, saga state | No automatic deletion.                                                                                                                                                                                                               |
| Payments and `payment_events`                   | No automatic deletion.                                                                                                                                                                                                               |
| Notifications (`notifications`)                 | Rows remain after scrubbing; non-sensitive template data (order reference, totals) is kept.                                                                                                                                          |
| Inventory reservations and `stock_adjustments`  | No automatic deletion.                                                                                                                                                                                                               |

## Observability data (local stack)

| Store                 | Retention                                         |
| --------------------- | ------------------------------------------------- |
| Loki logs             | 7 days (`infrastructure/loki/loki.yaml`)          |
| Prometheus metrics    | 3 days (`--storage.tsdb.retention.time=3d`)       |
| Jaeger traces         | In memory, up to 50 000 traces, lost on restart   |
| Docker container logs | `json-file` driver, 3 files × 10 MB per container |
| Mailpit emails        | Last 2 000 messages                               |

## What is not in place

This blueprint does not implement a data-subject erasure or export workflow ("right to be forgotten"), legal holds, or per-tenant retention. Erasing a user would have to cover every service that stores their data (auth, user, notification, order, payment, audit, dead letters, backups and log stores). Retention periods above are technical defaults, not legal advice; align them with your obligations before production use.
