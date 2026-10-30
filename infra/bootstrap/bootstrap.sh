#!/bin/sh
set -eu

export PGHOST=sql1 PGPORT=5432 PGUSER=postgres PGDATABASE=postgres PGCONNECT_TIMEOUT=5
export PGPASSWORD="$(cat /run/secrets/superuser_password)"
export APP_PASSWORD="$(cat /run/secrets/app_password)"

# Le mot de passe reste une variable du processus, sans argument de commande ni sortie SQL.
psql -X --no-password --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_PASSWORD
SELECT format('CREATE ROLE festival_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'festival_app') \gexec
ALTER ROLE festival_app SET statement_timeout = '8s';
ALTER ROLE festival_app SET lock_timeout = '5s';
ALTER ROLE festival_app SET idle_in_transaction_session_timeout = '15s';
SELECT 'CREATE DATABASE festival OWNER festival_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'festival') \gexec
SQL

export PGUSER=festival_app PGDATABASE=festival PGPASSWORD="${APP_PASSWORD}"
unset APP_PASSWORD
psql -X --no-password --set ON_ERROR_STOP=1 --file /bootstrap/schema.sql
printf '%s\n' 'Base festival et schéma initialisés.'
