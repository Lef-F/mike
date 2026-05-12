#!/usr/bin/env bash
# Smoke test: boot the default mode, hit Caddy, tear down.
# Run from repo root. Requires docker, docker compose, curl.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "smoke-test: .env not present. Generating from .env.example..."
  cp .env.example .env
  ./scripts/generate-secrets.sh
fi

PORT="$(awk -F= '$1 == "MIKE_PORT" { print $2 }' .env)"
PORT="${PORT:-80}"

echo "smoke-test: bringing stack up (default mode)..."
./mike up -d --build

cleanup() {
  echo "smoke-test: tearing down..."
  ./mike down --remove-orphans
}
trap cleanup EXIT

echo "smoke-test: waiting up to 120s for Caddy on :$PORT..."
i=0
until curl -fsS "http://localhost:$PORT" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "smoke-test: Caddy did not respond on :$PORT after 120s" >&2
    ./mike logs --tail 50 caddy mike-backend mike-frontend
    exit 1
  fi
  sleep 2
done

echo "smoke-test: Caddy responding on :$PORT"
echo "smoke-test: checking backend route /backend/healthz..."
curl -fsS "http://localhost:$PORT/backend/healthz" || {
  echo "smoke-test: backend healthz failed" >&2
  ./mike logs --tail 50 mike-backend
  exit 1
}
echo "smoke-test: PASS"
