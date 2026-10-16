#!/bin/sh
# Applies each service's own Prisma migrations to that service's own database,
# then (optionally) loads idempotent demo seed data.
#
#   MIGRATE_SERVICES   space-separated service names (default: all with migrations)
#   <SERVICE>_DATABASE_URL  e.g. ORDER_SERVICE_DATABASE_URL for order-service
#   RUN_SEED=true      run dist/seed.js for services that have one
set -eu
cd /app
services="${MIGRATE_SERVICES:-auth-service user-service product-service inventory-service order-service payment-service notification-service audit-service worker}"

log() { printf '{"level":"info","service":"migrator","target":"%s","message":"%s"}\n' "$1" "$2"; }

for service in $services; do
  var="$(echo "$service" | tr 'a-z-' 'A-Z_')_DATABASE_URL"
  url="$(printenv "$var" || true)"
  if [ -z "$url" ]; then
    echo "missing $var" >&2
    exit 1
  fi
  log "$service" "applying migrations"
  (cd "apps/$service" && DATABASE_URL="$url" ../../node_modules/.bin/prisma migrate deploy)
done

if [ "${RUN_SEED:-false}" = "true" ]; then
  for service in $services; do
    if [ -f "apps/$service/dist/seed.js" ]; then
      var="$(echo "$service" | tr 'a-z-' 'A-Z_')_DATABASE_URL"
      log "$service" "seeding demo data"
      (cd "apps/$service" && DATABASE_URL="$(printenv "$var")" node dist/seed.js)
    fi
  done
fi
if [ -n "${RABBITMQ_URL:-}" ]; then
  log "rabbitmq" "declaring messaging topology"
  node scripts/declare-topology.mjs
fi
log "all" "release steps complete"
