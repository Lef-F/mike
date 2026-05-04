#!/bin/sh
# Sources /run/secrets/garage.env (written by init-garage) so R2_* env vars
# are present when the Node process starts.
set -e

if [ -f /run/secrets/garage.env ]; then
  set -a
  . /run/secrets/garage.env
  set +a
fi

exec "$@"
