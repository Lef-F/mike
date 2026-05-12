#!/bin/sh
# init-db: applies Mike's SQL schema after the configured Postgres
# (bundled or external) is reachable and GoTrue has populated auth.users.
# Works for every MIKE_SUPABASE_MODE because it speaks plain psql.
set -e

# Build CONN: prefer PG_URL (hosted Supabase, byo-db) over individual vars.
if [ -n "${PG_URL:-}" ]; then
  CONN="$PG_URL"
else
  : "${PGHOST:?PGHOST or PG_URL must be set}"
  : "${PGUSER:?PGUSER must be set}"
  : "${PGDATABASE:?PGDATABASE must be set}"
  : "${PGPASSWORD:?PGPASSWORD must be set}"
  CONN="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:5432/${PGDATABASE}"
fi

echo "init-db: waiting for postgres..."
i=0
until pg_isready -d "$CONN" -q; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-db: postgres did not become ready after 60s" >&2
    exit 1
  fi
  sleep 1
done

echo "init-db: waiting for auth.users to exist..."
i=0
until [ "$(psql "$CONN" -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='users'")" = "1" ]; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-db: auth.users not present after 120s (GoTrue migrations didn't run?)" >&2
    exit 1
  fi
  sleep 2
done

echo "init-db: applying /migrations/000_one_shot_schema.sql"
psql "$CONN" -v ON_ERROR_STOP=1 -f /migrations/000_one_shot_schema.sql

# Apply incremental migrations in numeric order, skipping 000.
# All migrations are idempotent (CREATE OR REPLACE / IF NOT EXISTS / etc.)
# so re-running on every boot is safe.
ls /migrations/[0-9][0-9][0-9]_*.sql 2>/dev/null | sort | while IFS= read -r migration; do
  case "$(basename "$migration")" in
    000_*) continue ;;
  esac
  echo "init-db: applying $migration"
  psql "$CONN" -v ON_ERROR_STOP=1 -f "$migration"
done

echo "init-db: complete"
