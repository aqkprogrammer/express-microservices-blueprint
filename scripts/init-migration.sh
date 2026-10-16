#!/usr/bin/env bash
# Generates an initial migration from a service's Prisma schema without a
# database, appending the shared messaging constraints and optional extra SQL.
set -euo pipefail
name="$1"; extra_sql="${2:-}"
dir="apps/$name"
out="$dir/prisma/migrations/20261016000000_init"
mkdir -p "$out"
(cd "$dir" && npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script) \
  | sed '/^Loaded Prisma config/d; /^-- CreateSchema$/d; /^CREATE SCHEMA IF NOT EXISTS "public";$/d' \
  | sed '1{/^$/d}' > "$out/migration.sql"
cat scripts/templates/messaging-constraints.sql >> "$out/migration.sql"
if [ -n "$extra_sql" ]; then printf '\n%s\n' "$extra_sql" >> "$out/migration.sql"; fi
