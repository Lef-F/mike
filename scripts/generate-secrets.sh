#!/usr/bin/env bash
# Generates the secrets the docker-compose stack needs and writes them
# into ./.env. Idempotent: existing non-empty values are kept unless --force.
# Mode-aware: skips secrets that aren't used in the chosen
# MIKE_SUPABASE_MODE / MIKE_STORAGE_MODE.
set -euo pipefail

command -v openssl >/dev/null 2>&1 || { echo "error: openssl is required but not found on PATH" >&2; exit 1; }
umask 077

ENV_FILE="${ENV_FILE:-.env}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE does not exist. Run: cp .env.example $ENV_FILE" >&2
  exit 1
fi

# --- Helpers -----------------------------------------------------------------

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

mint_jwt() {
  local role="$1" secret="$2" now exp header payload b64h b64p sig
  now=$(date +%s)
  exp=$((now + 60 * 60 * 24 * 365 * 10))
  header='{"alg":"HS256","typ":"JWT"}'
  payload="{\"role\":\"$role\",\"aud\":\"authenticated\",\"iss\":\"mike-self-hosted\",\"iat\":$now,\"exp\":$exp}"
  b64h=$(printf '%s' "$header"  | b64url)
  b64p=$(printf '%s' "$payload" | b64url)
  sig=$(printf '%s.%s' "$b64h" "$b64p" \
        | openssl dgst -sha256 -mac HMAC -macopt "key:$secret" -binary | b64url)
  printf '%s.%s.%s' "$b64h" "$b64p" "$sig"
}

current_value() {
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); sub(/\r$/, ""); sub(/[[:space:]]+#.*$/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }' "$ENV_FILE"
}

set_value() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -F= -v k="$key" -v v="$val" '
      BEGIN { OFS="=" }
      $1 == k { print k "=" v; next }
      { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
}

ensure_random_hex() {
  local key="$1" bytes="$2" cur
  cur=$(current_value "$key")
  if [ -z "$cur" ] || [ "$FORCE" = 1 ]; then
    set_value "$key" "$(openssl rand -hex "$bytes")"
    echo "  set $key"
  else
    echo "  kept $key"
  fi
}

warn_required() {
  local key="$1" reason="$2"
  if [ -z "$(current_value "$key")" ]; then
    echo "  WARN: $key is empty — required because $reason" >&2
  fi
}

# --- Read modes --------------------------------------------------------------

SUPABASE_MODE="$(current_value MIKE_SUPABASE_MODE)"
STORAGE_MODE="$(current_value MIKE_STORAGE_MODE)"
SUPABASE_MODE="${SUPABASE_MODE:-bundled-full}"
STORAGE_MODE="${STORAGE_MODE:-bundled}"

echo "Generating secrets in $ENV_FILE (modes: supabase=$SUPABASE_MODE storage=$STORAGE_MODE; use --force to overwrite existing)..."

# --- Always required ---------------------------------------------------------

ensure_random_hex DOWNLOAD_SIGNING_SECRET 32
ensure_random_hex USER_API_KEYS_ENCRYPTION_KEY 32

# --- Postgres / GoTrue / PostgREST — bundled-* modes -------------------------

case "$SUPABASE_MODE" in
  bundled-full)
    ensure_random_hex POSTGRES_PASSWORD       24
    ensure_random_hex AUTHENTICATOR_PASSWORD  24
    ensure_random_hex JWT_SECRET              32
    JWT_SECRET_VAL=$(current_value JWT_SECRET)
    if [ -z "$(current_value SUPABASE_PUBLISHABLE_KEY)" ] || [ "$FORCE" = 1 ]; then
      set_value SUPABASE_PUBLISHABLE_KEY "$(mint_jwt anon "$JWT_SECRET_VAL")"
      echo "  set SUPABASE_PUBLISHABLE_KEY"
    else
      echo "  kept SUPABASE_PUBLISHABLE_KEY"
    fi
    if [ -z "$(current_value SUPABASE_SECRET_KEY)" ] || [ "$FORCE" = 1 ]; then
      set_value SUPABASE_SECRET_KEY "$(mint_jwt service_role "$JWT_SECRET_VAL")"
      echo "  set SUPABASE_SECRET_KEY"
    else
      echo "  kept SUPABASE_SECRET_KEY"
    fi
    ;;
  bundled-byo-db)
    ensure_random_hex AUTHENTICATOR_PASSWORD  24
    ensure_random_hex JWT_SECRET              32
    JWT_SECRET_VAL=$(current_value JWT_SECRET)
    if [ -z "$(current_value SUPABASE_PUBLISHABLE_KEY)" ] || [ "$FORCE" = 1 ]; then
      set_value SUPABASE_PUBLISHABLE_KEY "$(mint_jwt anon "$JWT_SECRET_VAL")"
      echo "  set SUPABASE_PUBLISHABLE_KEY"
    else
      echo "  kept SUPABASE_PUBLISHABLE_KEY"
    fi
    if [ -z "$(current_value SUPABASE_SECRET_KEY)" ] || [ "$FORCE" = 1 ]; then
      set_value SUPABASE_SECRET_KEY "$(mint_jwt service_role "$JWT_SECRET_VAL")"
      echo "  set SUPABASE_SECRET_KEY"
    else
      echo "  kept SUPABASE_SECRET_KEY"
    fi
    warn_required EXTERNAL_POSTGRES_URL "MIKE_SUPABASE_MODE=bundled-byo-db"
    warn_required EXTERNAL_POSTGRES_AUTHENTICATOR_URL "MIKE_SUPABASE_MODE=bundled-byo-db (PostgREST authenticator role)"
    warn_required EXTERNAL_SUPABASE_GOTRUE_PG_URL "MIKE_SUPABASE_MODE=bundled-byo-db (GoTrue needs search_path=auth)"
    ;;
  external)
    warn_required EXTERNAL_SUPABASE_URL "MIKE_SUPABASE_MODE=external"
    warn_required EXTERNAL_SUPABASE_ANON_KEY "MIKE_SUPABASE_MODE=external"
    warn_required EXTERNAL_SUPABASE_SERVICE_KEY "MIKE_SUPABASE_MODE=external"
    warn_required EXTERNAL_SUPABASE_PG_URL "MIKE_SUPABASE_MODE=external (init-db needs PG access)"
    ;;
  *)
    echo "error: MIKE_SUPABASE_MODE='$SUPABASE_MODE' is not one of bundled-full|bundled-byo-db|external" >&2
    exit 2
    ;;
esac

# --- Storage -----------------------------------------------------------------

case "$STORAGE_MODE" in
  bundled)
    ensure_random_hex GARAGE_RPC_SECRET   32
    ensure_random_hex GARAGE_ADMIN_TOKEN  32
    ;;
  external)
    warn_required R2_ENDPOINT_URL "MIKE_STORAGE_MODE=external"
    warn_required R2_ACCESS_KEY_ID "MIKE_STORAGE_MODE=external"
    warn_required R2_SECRET_ACCESS_KEY "MIKE_STORAGE_MODE=external"
    ;;
  *)
    echo "error: MIKE_STORAGE_MODE='$STORAGE_MODE' is not one of bundled|external" >&2
    exit 2
    ;;
esac

echo "Done."
