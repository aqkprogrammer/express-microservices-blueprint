# Troubleshooting

Common problems with the local stack and how to fix them. For production-style incident procedures see the [runbook](../operations/runbook.md); for error codes returned by the API see the [error catalogue](../api/errors.md).

First steps for almost any problem:

```sh
docker compose ps -a                          # which container is unhealthy, restarting or exited?
docker compose logs --tail=100 <service>      # why?
```

## Port already allocated

```text
Error response from daemon: ... Bind for 127.0.0.1:8080 failed: port is already allocated
```

Another process (or another Compose project) uses one of the published ports: 8080, 3000, 3009, 8025, 9090, 15672, 16686 — and with `docker-compose.dev.yml` also 5432, 5672, 6379, 1025 and 4318.

```sh
lsof -nP -iTCP:8080 -sTCP:LISTEN        # macOS/Linux
ss -ltnp | grep ':8080'                 # Linux
```

Stop that process, or remap the port in a git-ignored local override, e.g. `docker-compose.override.yml` (needs Docker Compose 2.24.4+ for `!override`):

```yaml
services:
  api-gateway:
    ports: !override
      - 127.0.0.1:18080:8080
```

A local PostgreSQL on 5432 commonly conflicts with `docker-compose.dev.yml`; stop it while running services from source.

## Docker Hub rate limit (429)

```text
toomanyrequests: You have reached your pull rate limit.
```

Anonymous pulls from Docker Hub are rate-limited. Options:

- `docker login` (authenticated pulls have a higher limit);
- configure a registry mirror in the Docker daemon (`/etc/docker/daemon.json`, or Docker Desktop → Settings → Docker Engine) and restart Docker:

  ```json
  { "registry-mirrors": ["https://<your-mirror>"] }
  ```

- retry later; images already pulled are cached.

## TLS-intercepting proxy during build

`npm ci` inside the image build fails with `SELF_SIGNED_CERT_IN_CHAIN` or `unable to get local issuer certificate` behind a corporate proxy that re-signs TLS traffic. Provide the proxy's CA bundle as a build secret:

```sh
EXTRA_CA_FILE=/path/to/corporate-ca.pem docker compose build
# or put EXTRA_CA_FILE=/path/to/corporate-ca.pem in .env
```

The file is mounted as a BuildKit secret only during the `npm ci` steps (`NODE_EXTRA_CA_CERTS`) and is never stored in an image layer. Without `EXTRA_CA_FILE`, an empty placeholder is used. For `npm ci` on the host, use `NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem npm ci`. Image pulls by the Docker daemon itself need the CA installed for the daemon (OS trust store or Docker Desktop settings).

## Out of memory

Symptoms: containers exit with code 137, `docker inspect --format '{{.State.OOMKilled}}' emb-<service>-1` prints `true`, or the whole machine slows down.

- Give Docker about **6 GB** of memory (Docker Desktop → Settings → Resources).
- Each service is limited to 256 MB (auth-service 384 MB: Argon2id needs ~19 MiB per concurrent login). Watch usage with `docker stats`.
- Run without the observability stack: services do not depend on Jaeger, Loki, Prometheus or Grafana, so start only the gateway and worker (Compose starts their dependencies) with telemetry export disabled:

  ```sh
  OTEL_SDK_DISABLED=true docker compose up -d --build api-gateway worker
  ```

## Migrator failed

```text
service "migrator" didn't complete successfully: exit 1
```

No application service starts until the one-shot `migrator` succeeds. Read its output:

```sh
docker compose logs migrator
```

| Message                                                | Cause                                                                                                                                                 | Fix                                                                                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `password authentication failed for user "orders_svc"` | Database passwords in `.env` changed after the PostgreSQL volume was first initialised. Roles are created only on the first start of an empty volume. | Restore the original passwords, or update the role: `docker compose exec postgres psql -U postgres -c "ALTER ROLE orders_svc PASSWORD '<new>';"`. Last resort: `docker compose down --volumes` (deletes all data). |
| `database "…_db" does not exist`                       | Volume initialised by an older version of the init script                                                                                             | Create the database and role by hand (see [adding a service](../development/adding-a-service.md#3-database-and-migrations)) or reset the volume                                                                    |
| `missing <SERVICE>_DATABASE_URL`                       | Migrator environment incomplete (custom Compose file)                                                                                                 | Add the variable to the `migrator` service                                                                                                                                                                         |
| Prisma migration error                                 | A migration's SQL failed                                                                                                                              | Fix the migration; never edit a migration that was already applied elsewhere — add a new one                                                                                                                       |
| RabbitMQ connection errors at the end                  | Broker not reachable while declaring the topology (the script retries for 120 s)                                                                      | Check `docker compose logs rabbitmq`                                                                                                                                                                               |

Re-run only the release step after fixing: `docker compose run --rm migrator`, then `docker compose up -d`.

## auth-service cannot read the key file

auth-service restarts and logs `EACCES: permission denied` or `ENOENT` for `/run/keys/jwt-private.pem`.

- The `keygen` container creates the key once in the `jwt-keys` volume and makes it readable only by uid 1000 (the `node` user). Re-run it to restore ownership: `docker compose run --rm keygen && docker compose up -d auth-service`.
- To start over with a new key: `docker compose down && docker volume rm emb_jwt-keys && docker compose up -d`. All previously issued access tokens become invalid.
- Running from source: `npm run keys:generate` writes `secrets/jwt-private.pem` with mode `0400`; it must be owned by the user running the service, and `JWT_PRIVATE_KEY_FILE=secrets/jwt-private.pem` must be set (`npm run dev` does this).

## 401 invalid token after restart

`401 unauthorized` with detail `Token is invalid` for a token that worked before:

- The signing key changed: the `jwt-keys` volume was recreated (e.g. `docker compose down --volumes`), or you switched between the containerised auth-service and one running from source (different keys).
- `Token has expired`: access tokens live 15 minutes.

Log in again, or call `POST /api/v1/auth/refresh` with the refresh token (refresh tokens are stored in `auth_db` and survive a key change, unless the database volume was wiped too).

## 429 rate limited

`429` with code `rate_limited` comes from the gateway: 300 requests/min per IP overall, 20/min per IP on login, register, refresh and password reset. Responses carry `Retry-After`, `RateLimit` and `RateLimit-Policy` headers.

- For local load or e2e runs, raise `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` in `.env` and `docker compose up -d api-gateway`.
- Counters live in Redis under `rl:global:` and `rl:auth:`. Locally it is safe to clear Redis completely — it only holds caches and counters: `docker compose exec redis redis-cli FLUSHALL`.

`429` with code `account_locked` comes from auth-service: 5 failed logins lock the account for 15 minutes (`Retry-After` says how long). There is no unlock endpoint; wait, or locally reset it:

```sh
docker compose exec postgres psql -U postgres -d auth_db -c \
  "UPDATE credentials SET failed_login_count = 0, locked_until = NULL WHERE email = 'alice@example.test';"
```

## 503 circuit open

`503 service_unavailable` with detail `<name>-service is temporarily unavailable` and `Retry-After: 5`:

- **At the gateway:** five consecutive failures (connection errors, timeouts, or 502/503/504 answers) from that upstream opened its circuit for 10 s; after that one trial request is let through.
- **From order-service** (`POST /api/v1/orders`): its client to product-service has its own circuit breaker.
- `Token verification is temporarily unavailable`: the service cannot fetch the JWKS from auth-service.

Check the upstream with `docker compose ps` and its logs; once it is healthy, the circuit closes on the next successful trial. `gateway_upstream_circuit_open` and `http_client_circuit_open` show the state in Prometheus.

## Orders stuck in AWAITING_PAYMENT

An order waits in `AWAITING_PAYMENT` until payment-service reports an outcome. With the `sim_provider_timeout` token this is deliberate: the simulated provider times out and only reports the authorization as approved once 20 s have passed since the first attempt. Resolution then follows two paths, whichever comes first:

- order-service checks overdue saga steps every 10 s; after `SAGA_PAYMENT_TIMEOUT_MS` (15 s in Compose, 60 s by default) it looks the payment up and, while the outcome is unknown, re-requests authorization (up to `SAGA_MAX_PAYMENT_ATTEMPTS` = 3) — payment-service asks the provider first, so this never double-charges;
- payment-service's `payment.reconcile` task (every 15 s) resolves payments `PROCESSING` for more than 20 s.

So a timeout-scenario order normally becomes `CONFIRMED` within about a minute; the exact time depends on where the scheduler ticks fall. Check progress:

```sh
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/orders/<orderId> | jq '{status, saga}'
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/v1/payments?orderId=<orderId>" | jq '.data[] | {status, authorizationAttempts}'
```

If it stays longer:

| Check                                                                                                                                                                      | Why                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `docker compose ps worker` and `docker compose exec postgres psql -U postgres -d worker_db -c "SELECT task, outcome, started_at FROM job_runs ORDER BY id DESC LIMIT 10;"` | Without the worker no timeout checks or reconciliation run                                                   |
| `docker compose ps payment-service`                                                                                                                                        | If payment-service is unreachable, order-service pushes the deadline out by 15 s each time and keeps waiting |
| RabbitMQ UI → `order-service.events`, `payment-service.events`                                                                                                             | Messages stuck or not consumed                                                                               |

After 3 unresolved attempts the order moves to `REQUIRES_REVIEW`; if no outcome arrives within the stock reservation TTL (15 min), the reservation expires and the order is cancelled (`reservation_expired`). See the [runbook](../operations/runbook.md#orders-requiring-review).

## Emails not arriving

- Open Mailpit at <http://localhost:8025>; Compose sends all email there (`EMAIL_TRANSPORT=smtp`, `SMTP_HOST=mailpit`). Nothing leaves your machine.
- Recipients at **`@bounce.test` fail on purpose** (`SIMULATE_FAILURE_DOMAIN=bounce.test`) to demonstrate retries (2 s, 10 s, 30 s), `NotificationDeliveryFailed` and dead-lettering. Use another domain (e.g. `@example.test`) for normal tests, or set `SIMULATE_FAILURE_DOMAIN=` in `.env`.
- Notifications need the recipient read model, which is filled from `UserRegistered` asynchronously; a first attempt can fail with `RecipientNotFoundError` and succeed on retry.
- Check the notification's status: `GET /api/v1/notifications` (own notifications; admins can filter with `?status=FAILED&recipientUserId=<id>`), and the [dead letters](../operations/runbook.md#dead-letters).
- Running from source without SMTP: `EMAIL_TRANSPORT=console` logs a redacted line instead of sending.

## Profile not found right after registration

`GET /api/v1/users/me` can return `404` for a moment after `POST /api/v1/auth/register`: the profile is created by user-service when it consumes `UserRegistered`. Retry after a short delay. If it persists, check `user-service.events` in RabbitMQ and the [dead letters](../operations/runbook.md#dead-letters).

## Data disappeared

`docker compose down --volumes` (or `docker volume rm emb_…`) **permanently deletes** all local data: databases, broker state, dashboards' storage, logs, metrics and the JWT signing key. Plain `docker compose down` keeps volumes. Take a dump first if you need the data — see [backup and restore](../operations/backup-restore.md). Seed data (8 products, the admin account) is recreated automatically on the next start.
