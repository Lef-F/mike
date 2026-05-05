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

echo "init-db: complete"
