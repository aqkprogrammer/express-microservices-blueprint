#!/bin/sh
# Creates one database and one login role per service. Each role owns only its
# own database, and PUBLIC loses CONNECT, so a service cannot even connect to
# another service's database. Runs once, on first start of an empty volume.
set -eu

create() {
  service="$1"; password="$2"
  db="${service}_db"; role="${service}_svc"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v role="$role" -v db="$db" -v password="$password" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE :"db" OWNER :"role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" -v role="$role" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"role";
SQL
}

create auth "${AUTH_DB_PASSWORD}"
create users "${USER_DB_PASSWORD}"
create product "${PRODUCT_DB_PASSWORD}"
create inventory "${INVENTORY_DB_PASSWORD}"
create orders "${ORDER_DB_PASSWORD}"
create payment "${PAYMENT_DB_PASSWORD}"
create notification "${NOTIFICATION_DB_PASSWORD}"
create audit "${AUDIT_DB_PASSWORD}"
create worker "${WORKER_DB_PASSWORD}"
