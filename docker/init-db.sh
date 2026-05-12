#!/bin/sh
# init-db: applies Mike's SQL schema after the configured Postgres
# (bundled or external) is reachable and GoTrue has populated auth.users.
# Works for every MIKE_SUPABASE_MODE because it speaks plain psql.
set -e

# In bundled-fallback mode we use individual PG* env vars so the password
# stays in PGPASSWORD (read silently by psql) and is never embedded in a
# connection-string that error messages would echo to stderr / docker logs.
# In PG_URL mode the operator chose to put credentials in the URL themselves.
if [ -n "${PG_URL:-}" ]; then
  PSQL_ARGS="$PG_URL"
  CONN_DESC="$(printf '%s' "$PG_URL" | sed 's|://[^@]*@|://|')"
else
  : "${PGHOST:?PGHOST or PG_URL must be set}"
  : "${PGUSER:?PGUSER must be set}"
  : "${PGDATABASE:?PGDATABASE must be set}"
  : "${PGPASSWORD:?PGPASSWORD must be set}"
  PSQL_ARGS="-h $PGHOST -U $PGUSER -d $PGDATABASE"
  CONN_DESC="${PGUSER}@${PGHOST}/${PGDATABASE}"
fi

echo "init-db: waiting for postgres at $CONN_DESC..."
i=0
# shellcheck disable=SC2086  # PSQL_ARGS is intentionally split into flags
until pg_isready $PSQL_ARGS -q; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-db: postgres did not become ready after 60s" >&2
    exit 1
  fi
  sleep 1
done

echo "init-db: waiting for auth.users to exist..."
i=0
# shellcheck disable=SC2086
until [ "$(psql $PSQL_ARGS -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='users'")" = "1" ]; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-db: auth.users not present after 120s (GoTrue migrations didn't run?)" >&2
    exit 1
  fi
  sleep 2
done

echo "init-db: applying /migrations/000_one_shot_schema.sql"
# shellcheck disable=SC2086
psql $PSQL_ARGS -v ON_ERROR_STOP=1 -f /migrations/000_one_shot_schema.sql

# Apply incremental migrations in numeric order, skipping 000.
# All migrations are idempotent (CREATE OR REPLACE / IF NOT EXISTS / etc.)
# so re-running on every boot is safe.
applied=0
for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  # If no files match the glob, the literal pattern is preserved — skip it.
  case "$migration" in
    "/migrations/[0-9][0-9][0-9]_*.sql") continue ;;
  esac
  case "$(basename "$migration")" in
    000_*) continue ;;
  esac
  echo "init-db: applying $migration"
  # shellcheck disable=SC2086
  psql $PSQL_ARGS -v ON_ERROR_STOP=1 -f "$migration"
  applied=$((applied+1))
done
echo "init-db: applied $applied incremental migrations"

echo "init-db: complete"
