#!/usr/bin/env bash
# Generates the secrets the docker-compose stack needs and writes them
# into ./.env. Idempotent: existing non-empty values are kept unless --force.
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
  # mint_jwt <role> <secret>
  local role="$1" secret="$2" now exp header payload b64h b64p sig
  now=$(date +%s)
  exp=$((now + 60 * 60 * 24 * 365 * 10))   # ~10 years
  header='{"alg":"HS256","typ":"JWT"}'
  payload="{\"role\":\"$role\",\"aud\":\"authenticated\",\"iss\":\"mike-self-hosted\",\"iat\":$now,\"exp\":$exp}"
  b64h=$(printf '%s' "$header"  | b64url)
  b64p=$(printf '%s' "$payload" | b64url)
  sig=$(printf '%s.%s' "$b64h" "$b64p" \
        | openssl dgst -sha256 -mac HMAC -macopt "key:$secret" -binary | b64url)
  printf '%s.%s.%s' "$b64h" "$b64p" "$sig"
}

current_value() {
  # current_value <KEY>  -> prints existing value (may be empty), stripping inline comments and whitespace
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); sub(/\r$/, ""); sub(/[[:space:]]*#.*$/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }' "$ENV_FILE"
}

set_value() {
  # set_value <KEY> <VALUE>
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # Replace in place (portable: write to tmp + mv).
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
  # ensure_random_hex <KEY> <BYTES>
  local key="$1" bytes="$2" cur
  cur=$(current_value "$key")
  if [ -z "$cur" ] || [ "$FORCE" = 1 ]; then
    set_value "$key" "$(openssl rand -hex "$bytes")"
    echo "  set $key"
  else
    echo "  kept $key"
  fi
}

# --- Generate secrets --------------------------------------------------------

echo "Generating secrets in $ENV_FILE (use --force to overwrite existing)..."

ensure_random_hex POSTGRES_PASSWORD     24
ensure_random_hex AUTHENTICATOR_PASSWORD 24
ensure_random_hex GARAGE_RPC_SECRET     32
ensure_random_hex GARAGE_ADMIN_TOKEN    32
ensure_random_hex JWT_SECRET            32

# JWTs depend on JWT_SECRET; regenerate them whenever JWT_SECRET changed
# (i.e. when the user runs --force) or when they're empty.
JWT_SECRET_VAL=$(current_value JWT_SECRET)

regen_jwt() {
  local key="$1" role="$2" cur
  cur=$(current_value "$key")
  if [ -z "$cur" ] || [ "$FORCE" = 1 ]; then
    set_value "$key" "$(mint_jwt "$role" "$JWT_SECRET_VAL")"
    echo "  set $key"
  else
    echo "  kept $key"
  fi
}

regen_jwt SUPABASE_PUBLISHABLE_KEY anon
regen_jwt SUPABASE_SECRET_KEY      service_role

echo "Done."
