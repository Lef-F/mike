#!/bin/sh
# init-db: applies Mike's one-shot SQL schema after GoTrue has finished its
# own startup migrations (so that auth.users exists for the FK references).
set -e

: "${PGHOST:?PGHOST not set}"
: "${PGUSER:?PGUSER not set}"
: "${PGDATABASE:?PGDATABASE not set}"
: "${PGPASSWORD:?PGPASSWORD not set}"

echo "init-db: waiting for postgres..."
until pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -q; do
  sleep 1
done

echo "init-db: waiting for gotrue migrations (auth.users)..."
i=0
until [ "$(psql -tAc "SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='users'")" = "1" ]; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-db: gotrue did not create auth.users after 120s" >&2
    exit 1
  fi
  sleep 2
done

echo "init-db: applying /migrations/000_one_shot_schema.sql"
psql -v ON_ERROR_STOP=1 -f /migrations/000_one_shot_schema.sql

# Apply incremental migrations in numeric order, skipping 000 (the
# one-shot schema we already applied above). Each is idempotent
# (CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS / etc.) so re-running
# on every boot is safe.
ls /migrations/[0-9][0-9][0-9]_*.sql 2>/dev/null | sort | while IFS= read -r migration; do
  case "$(basename "$migration")" in
    000_*) continue ;;
  esac
  echo "init-db: applying $migration"
  psql -v ON_ERROR_STOP=1 -f "$migration"
done

echo "init-db: complete"
