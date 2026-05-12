#!/bin/sh
# Sources /run/secrets/garage.env (written by init-garage in bundled
# storage mode) so R2_* env vars are present when Node starts. In
# external storage mode, R2_* come from .env and we skip the source.
set -e

if [ -n "${R2_ACCESS_KEY_ID:-}" ]; then
  echo "backend-entrypoint: R2_ACCESS_KEY_ID already set in env (external storage mode)"
else
  echo "backend-entrypoint: waiting for /run/secrets/garage.env (bundled storage mode)"
  i=0
  while [ ! -f /run/secrets/garage.env ]; do
    i=$((i+1))
    if [ "$i" -gt 60 ]; then
      echo "backend-entrypoint: /run/secrets/garage.env not present after 60s" >&2
      echo "backend-entrypoint: did init-garage run? for external storage, set R2_ACCESS_KEY_ID in .env" >&2
      exit 1
    fi
    sleep 1
  done
  set -a
  . /run/secrets/garage.env
  set +a
fi

exec "$@"
