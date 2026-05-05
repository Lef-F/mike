# Self-Hosted Docker Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this fork of Mike runnable on a single host via `docker compose up`, with no managed services.

**Architecture:** Slim Supabase-equivalent (vanilla Postgres + GoTrue + PostgREST) plus single-node Garage for S3, two custom-built images for Mike's frontend and backend, and a single Caddy ingress that path-routes everything onto one configurable port. Two one-shot init containers handle first-boot bootstrap idempotently.

**Tech Stack:** Docker Compose v2, Caddy 2, Postgres 16, GoTrue, PostgREST, Garage v2 (S3 backend), Node 22 (backend), Next.js 16 (frontend), LibreOffice (DOCX→PDF in backend image).

**Spec:** `docs/superpowers/specs/2026-05-02-self-host-docker-compose-design.md`

**Working directory:** `/Users/lef/repos/lef/mike` (the fork). Upstream remains untouched at `/Users/lef/Repos/llm-stuff/mike` and is the read-only reference for source code.

---

## File Structure

All new files; nothing in `backend/` or `frontend/` is modified. The existing `.gitignore` already ignores `.env` and whitelists `!.env.example`, so no `.gitignore` change is needed.

```
mike/
├── .env.example                         # Task 2 — root-level env template
├── docker-compose.yml                   # Task 10 — wires everything
├── Caddyfile                            # Task 9 — ingress routing
├── docker/                              # all created in Tasks 3–8
│   ├── postgres-init.sh                 # Task 3 — roles, grants, auth.uid()
│   ├── garage.toml                      # Task 4 — Garage single-node config
│   ├── init-db.sh                       # Task 5 — runs Mike's SQL migration
│   ├── init-garage.sh                   # Task 6 — creates bucket + key
│   ├── backend.Dockerfile               # Task 7
│   ├── backend-entrypoint.sh            # Task 7
│   └── frontend.Dockerfile              # Task 8
├── scripts/
│   └── generate-secrets.sh              # Task 1
└── README.md                            # Task 12 — append self-host section
```

Each file has a single responsibility. The script files are kept short (<60 lines each) so they remain easy to read.

---

## Task 1: Generate-secrets script

**Files:**
- Create: `scripts/generate-secrets.sh`

The script generates every secret the stack needs and writes them into `.env`. Pure POSIX shell + `openssl` only — no Node, no Python, runs identically on Linux and macOS.

- [ ] **Step 1: Create the script**

Create `scripts/generate-secrets.sh`:

```bash
#!/usr/bin/env bash
# Generates the secrets the docker-compose stack needs and writes them
# into ./.env. Idempotent: existing non-empty values are kept unless --force.
set -euo pipefail

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
  payload="{\"role\":\"$role\",\"iss\":\"mike-self-hosted\",\"iat\":$now,\"exp\":$exp}"
  b64h=$(printf '%s' "$header"  | b64url)
  b64p=$(printf '%s' "$payload" | b64url)
  sig=$(printf '%s.%s' "$b64h" "$b64p" \
        | openssl dgst -sha256 -mac HMAC -macopt "key:$secret" -binary | b64url)
  printf '%s.%s.%s' "$b64h" "$b64p" "$sig"
}

current_value() {
  # current_value <KEY>  -> prints existing value (may be empty)
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
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
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
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
```

- [ ] **Step 2: Make it executable**

```
chmod +x scripts/generate-secrets.sh
```

- [ ] **Step 3: Verify it generates valid JWTs against a stub .env**

```
echo "" > /tmp/test.env
ENV_FILE=/tmp/test.env ./scripts/generate-secrets.sh
```

Expected: prints `set POSTGRES_PASSWORD`, `set AUTHENTICATOR_PASSWORD`, `set GARAGE_RPC_SECRET`, `set GARAGE_ADMIN_TOKEN`, `set JWT_SECRET`, `set SUPABASE_PUBLISHABLE_KEY`, `set SUPABASE_SECRET_KEY`. The two JWTs in `/tmp/test.env` should each look like three base64url segments separated by `.`. Decode the payload of `SUPABASE_PUBLISHABLE_KEY` to confirm `"role":"anon"`:

```
grep ^SUPABASE_PUBLISHABLE_KEY= /tmp/test.env | cut -d= -f2 \
  | cut -d. -f2 | tr '_-' '/+' \
  | awk '{ pad = (4 - length($0) % 4) % 4; printf "%s%s", $0, substr("====", 1, pad) }' \
  | base64 -d
```

Expected output: a JSON blob containing `"role":"anon"`.

Then run again without `--force` to confirm idempotence:

```
ENV_FILE=/tmp/test.env ./scripts/generate-secrets.sh
```

Expected: every line says `kept <KEY>`.

Clean up: `rm /tmp/test.env`.

- [ ] **Step 4: Commit**

```
git add scripts/generate-secrets.sh
git commit -m "feat: add generate-secrets.sh for docker-compose self-host stack"
```

---

## Task 2: Root `.env.example`

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Create the file**

Create `.env.example`:

```
# Mike — self-hosted docker-compose stack.
# 1. cp .env.example .env
# 2. ./scripts/generate-secrets.sh        (fills the empty values below)
# 3. Edit ANTHROPIC_API_KEY and/or GEMINI_API_KEY.
# 4. docker compose up -d

# --- Ingress -----------------------------------------------------------------
# Caddy listens on this port on the host. Mike's frontend bakes URLs at build
# time, so changing MIKE_HOST or MIKE_PORT requires:
#   docker compose build mike-frontend
MIKE_HOST=localhost
MIKE_PORT=80

# --- Postgres ----------------------------------------------------------------
POSTGRES_USER=postgres
POSTGRES_DB=postgres
POSTGRES_PASSWORD=                 # set by generate-secrets.sh
AUTHENTICATOR_PASSWORD=            # set by generate-secrets.sh; PostgREST role

# --- Supabase / GoTrue keys --------------------------------------------------
JWT_SECRET=                        # set by generate-secrets.sh
SUPABASE_PUBLISHABLE_KEY=          # set by generate-secrets.sh (anon JWT)
SUPABASE_SECRET_KEY=               # set by generate-secrets.sh (service_role JWT)

# --- GoTrue (laptop defaults; flip to false + add SMTP for real email) -------
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_DISABLE_SIGNUP=false

# --- LLM providers (set at least one) ----------------------------------------
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# --- Garage ------------------------------------------------------------------
GARAGE_RPC_SECRET=                 # set by generate-secrets.sh
GARAGE_ADMIN_TOKEN=                # set by generate-secrets.sh
R2_BUCKET_NAME=mike
# R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are not in this file — they are
# generated by the init-garage container on first boot and mounted into
# mike-backend at /run/secrets/garage.env.
```

- [ ] **Step 2: Verify**

```
cp .env.example .env && ./scripts/generate-secrets.sh && \
  grep -E "^(POSTGRES_PASSWORD|JWT_SECRET|SUPABASE_PUBLISHABLE_KEY|SUPABASE_SECRET_KEY|GARAGE_RPC_SECRET|GARAGE_ADMIN_TOKEN|AUTHENTICATOR_PASSWORD)=" .env \
  | awk -F= '{ if ($2 == "") { print "EMPTY: " $1; exit 1 } }'
echo "ok"
rm .env
```

Expected: prints `ok`. Any empty key name printed instead means the script and template are out of sync.

- [ ] **Step 3: Commit**

```
git add .env.example
git commit -m "feat: add root .env.example for docker-compose stack"
```

---

## Task 3: Postgres init script

**Files:**
- Create: `docker/postgres-init.sh`

This runs once on the first Postgres container boot via `/docker-entrypoint-initdb.d/`. It creates the four PostgREST/RLS roles and the `auth.uid()` / `auth.role()` helpers Mike's RLS policies use.

- [ ] **Step 1: Create the script**

Create `docker/postgres-init.sh`:

```bash
#!/bin/bash
# Runs on first Postgres start (mounted into /docker-entrypoint-initdb.d/).
# Creates the roles PostgREST and Mike's RLS policies expect, plus the
# auth.uid()/auth.role() helpers Supabase normally ships in separate migrations.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname   "$POSTGRES_DB" <<EOSQL
-- Roles -----------------------------------------------------------------
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${AUTHENTICATOR_PASSWORD}';
  END IF;
END
\$\$;

GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES    TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;

-- auth schema and JWT helpers ------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS \$\$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid
\$\$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS \$\$
  SELECT current_setting('request.jwt.claims', true)::jsonb ->> 'role'
\$\$;

GRANT EXECUTE ON FUNCTION auth.uid()  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
EOSQL

echo "postgres-init: roles, schema, and auth helpers ready"
```

- [ ] **Step 2: Make executable**

```
chmod +x docker/postgres-init.sh
```

- [ ] **Step 3: Verify against a throwaway Postgres**

```
docker run --rm -d --name pg-verify \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=postgres \
  -e AUTHENTICATOR_PASSWORD=auth-test \
  -v "$PWD/docker/postgres-init.sh:/docker-entrypoint-initdb.d/00-init.sh:ro" \
  postgres:16-alpine

# Wait for it to settle
sleep 8

docker exec pg-verify psql -U postgres -d postgres -tAc \
  "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','authenticator') ORDER BY rolname"

docker exec pg-verify psql -U postgres -d postgres -tAc \
  "SELECT proname FROM pg_proc WHERE proname IN ('uid','role') AND pronamespace = 'auth'::regnamespace"

docker rm -f pg-verify
```

Expected first query: prints `anon`, `authenticated`, `authenticator`, `service_role` (one per line).
Expected second query: prints `role`, `uid`.

- [ ] **Step 4: Commit**

```
git add docker/postgres-init.sh
git commit -m "feat: add postgres init script for PostgREST roles and auth helpers"
```

---

## Task 4: Garage config

**Files:**
- Create: `docker/garage.toml`

Single-node Garage with `replication_factor = 1`, internal-only ports. RPC and admin secrets come from environment.

- [ ] **Step 1: Create the file**

Create `docker/garage.toml`:

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir     = "/var/lib/garage/data"
db_engine    = "lmdb"

replication_factor = 1

rpc_bind_addr   = "[::]:3901"
rpc_public_addr = "garage:3901"
# rpc_secret is supplied via the GARAGE_RPC_SECRET environment variable.

[s3_api]
api_bind_addr = "[::]:3900"
s3_region     = "garage"
root_domain   = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
# admin_token / metrics_token come from GARAGE_ADMIN_TOKEN.
```

- [ ] **Step 2: Verify Garage accepts the config**

```
docker run --rm \
  -e GARAGE_RPC_SECRET="$(openssl rand -hex 32)" \
  -e GARAGE_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  -v "$PWD/docker/garage.toml:/etc/garage.toml:ro" \
  dxflrs/garage:v2.3.0 /garage --config /etc/garage.toml --help >/dev/null
echo "ok"
```

Expected: prints `ok` (the `--help` short-circuits before running, but Garage will reject a malformed config first).

- [ ] **Step 3: Commit**

```
git add docker/garage.toml
git commit -m "feat: add garage single-node config for self-host stack"
```

---

## Task 5: init-db script

**Files:**
- Create: `docker/init-db.sh`

Runs in a one-shot `postgres:16-alpine` container after Postgres and GoTrue are healthy. Applies Mike's existing migration file. Idempotent: the migration uses `if not exists` everywhere.

- [ ] **Step 1: Create the script**

Create `docker/init-db.sh`:

```bash
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
```

- [ ] **Step 2: Make executable**

```
chmod +x docker/init-db.sh
```

- [ ] **Step 3: Sanity-check the script syntax**

```
sh -n docker/init-db.sh && echo ok
```

Expected: `ok`. (Full integration is verified in Task 11's smoke test, since this script needs the full stack running.)

- [ ] **Step 4: Commit**

```
git add docker/init-db.sh
git commit -m "feat: add init-db script for applying mike schema"
```

---

## Task 6: init-garage script

**Files:**
- Create: `docker/init-garage.sh`

Runs in a one-shot `dxflrs/garage:v2.3.0` container after Garage is healthy. Initializes the cluster layout (single node, `dc1`, 10 GB capacity), creates the `mike` bucket and `mike-key` access key, and writes the credentials to a shared volume that `mike-backend` reads at startup.

- [ ] **Step 1: Create the script**

Create `docker/init-garage.sh`:

```sh
#!/bin/sh
# init-garage: bootstraps a single-node Garage cluster and creates the
# Mike bucket + access key. Writes R2_ACCESS_KEY_ID/SECRET to /secrets.
set -e

# `garage` CLI reads RPC config from /etc/garage.toml + env (RPC secret).
# Both are mounted/passed in by the compose service.

echo "init-garage: waiting for daemon..."
i=0
until garage status >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 60 ]; then
    echo "init-garage: daemon did not respond after 60s" >&2
    exit 1
  fi
  sleep 1
done

# Initialize cluster layout if not already committed.
if ! garage layout show 2>/dev/null | grep -q "Current cluster layout version: [1-9]"; then
  echo "init-garage: assigning cluster layout"
  NODE_ID=$(garage status | awk 'NR>2 && $1 ~ /^[0-9a-f]+$/ { print $1; exit }')
  if [ -z "$NODE_ID" ]; then
    echo "init-garage: could not determine node id from 'garage status'" >&2
    garage status >&2
    exit 1
  fi
  garage layout assign "$NODE_ID" -z dc1 -c 10G
  garage layout apply --version 1
fi

# Create bucket (idempotent).
echo "init-garage: ensuring bucket 'mike'"
garage bucket create mike 2>/dev/null || true

# Create or reuse access key.
echo "init-garage: ensuring key 'mike-key'"
if ! garage key info mike-key >/dev/null 2>&1; then
  garage key create mike-key
fi

# Allow the key to read+write the bucket (idempotent).
garage bucket allow --read --write --owner mike-key mike

# Extract creds and write to the shared secrets volume.
KEY_INFO=$(garage key info mike-key --show-secret)
KEY_ID=$(printf '%s\n' "$KEY_INFO"  | awk -F': *' '/Key ID/    { print $2; exit }')
SECRET=$(printf '%s\n' "$KEY_INFO" | awk -F': *' '/Secret key/ { print $2; exit }')

if [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; then
  echo "init-garage: failed to parse key info" >&2
  printf '%s\n' "$KEY_INFO" >&2
  exit 1
fi

mkdir -p /secrets
umask 077
cat > /secrets/garage.env <<EOF
R2_ACCESS_KEY_ID=$KEY_ID
R2_SECRET_ACCESS_KEY=$SECRET
EOF

echo "init-garage: complete (creds written to /secrets/garage.env)"
```

- [ ] **Step 2: Make executable**

```
chmod +x docker/init-garage.sh
```

- [ ] **Step 3: Sanity-check syntax**

```
sh -n docker/init-garage.sh && echo ok
```

Expected: `ok`. Full integration is verified in Task 11.

- [ ] **Step 4: Commit**

```
git add docker/init-garage.sh
git commit -m "feat: add init-garage script for bucket and key bootstrap"
```

---

## Task 7: Backend image

**Files:**
- Create: `docker/backend.Dockerfile`
- Create: `docker/backend-entrypoint.sh`

Multi-stage Dockerfile. Build stage compiles TypeScript; runtime stage adds LibreOffice. The entrypoint sources `/run/secrets/garage.env` (written by the `init-garage` container) before starting Node.

- [ ] **Step 1: Create the entrypoint**

Create `docker/backend-entrypoint.sh`:

```sh
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
```

- [ ] **Step 2: Make it executable**

```
chmod +x docker/backend-entrypoint.sh
```

- [ ] **Step 3: Create the Dockerfile**

Create `docker/backend.Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer \
      fonts-liberation fonts-dejavu-core \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist          ./dist
COPY --from=build /app/package.json  ./package.json
COPY docker/backend-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 3001
ENV NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
```

- [ ] **Step 4: Verify the image builds**

```
docker build -f docker/backend.Dockerfile -t mike-backend:verify .
```

Expected: build succeeds. The image is ~1.0–1.2 GB (Node + LibreOffice writer subset).

- [ ] **Step 5: Verify the entrypoint sources the secrets file**

```
docker run --rm \
  -e R2_ENDPOINT_URL=http://garage:3900 \
  -v /tmp/dummy-secrets:/run/secrets \
  --entrypoint /bin/sh \
  mike-backend:verify -c \
    'mkdir -p /run/secrets && \
     echo "R2_ACCESS_KEY_ID=AAA" > /run/secrets/garage.env && \
     echo "R2_SECRET_ACCESS_KEY=BBB" >> /run/secrets/garage.env && \
     /usr/local/bin/entrypoint.sh sh -c "echo $R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY"'
```

Expected: prints `AAA:BBB`.

- [ ] **Step 6: Cleanup and commit**

```
docker rmi mike-backend:verify
rm -rf /tmp/dummy-secrets
git add docker/backend.Dockerfile docker/backend-entrypoint.sh
git commit -m "feat: add mike-backend Dockerfile with libreoffice"
```

---

## Task 8: Frontend image

**Files:**
- Create: `docker/frontend.Dockerfile`

Standard Next.js build. `NEXT_PUBLIC_*` are passed as build args (baked at build time).

- [ ] **Step 1: Create the Dockerfile**

Create `docker/frontend.Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY \
    NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/.next        ./.next
COPY --from=build /app/public       ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm","run","start"]
```

- [ ] **Step 2: Verify the image builds with stub args**

```
docker build -f docker/frontend.Dockerfile \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=http://localhost \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=stub.stub.stub \
  --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost/backend \
  -t mike-frontend:verify .
```

Expected: build succeeds. The image is ~700–900 MB.

- [ ] **Step 3: Cleanup and commit**

```
docker rmi mike-frontend:verify
git add docker/frontend.Dockerfile
git commit -m "feat: add mike-frontend Dockerfile"
```

---

## Task 9: Caddyfile

**Files:**
- Create: `Caddyfile`

Single ingress, configurable host:port, path-routes to four upstreams.

- [ ] **Step 1: Create the file**

Create `Caddyfile`:

```caddy
{
  auto_https off
}

{$MIKE_HOST}:{$MIKE_PORT} {
  encode gzip

  handle_path /auth/v1/* {
    reverse_proxy gotrue:9999
  }

  handle_path /rest/v1/* {
    reverse_proxy postgrest:3000
  }

  handle_path /backend/* {
    reverse_proxy mike-backend:3001
  }

  handle {
    reverse_proxy mike-frontend:3000
  }
}
```

- [ ] **Step 2: Validate syntax with Caddy itself**

```
docker run --rm \
  -e MIKE_HOST=localhost \
  -e MIKE_PORT=80 \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expected: prints `Valid configuration`.

- [ ] **Step 3: Commit**

```
git add Caddyfile
git commit -m "feat: add caddyfile ingress for self-host stack"
```

---

## Task 10: docker-compose.yml

**Files:**
- Create: `docker-compose.yml`

Wires every previous artifact together. Ports: only Caddy is published.

- [ ] **Step 1: Create the file**

Create `docker-compose.yml`:

```yaml
name: mike

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      AUTHENTICATOR_PASSWORD: ${AUTHENTICATOR_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/postgres-init.sh:/docker-entrypoint-initdb.d/00-init.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 20

  gotrue:
    image: supabase/gotrue:v2.166.0
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?sslmode=disable&search_path=auth
      GOTRUE_SITE_URL: http://${MIKE_HOST}:${MIKE_PORT}
      GOTRUE_URI_ALLOW_LIST: http://${MIKE_HOST}:${MIKE_PORT}
      GOTRUE_DISABLE_SIGNUP: ${GOTRUE_DISABLE_SIGNUP}
      GOTRUE_MAILER_AUTOCONFIRM: ${GOTRUE_MAILER_AUTOCONFIRM}
      GOTRUE_JWT_SECRET: ${JWT_SECRET}
      GOTRUE_JWT_EXP: 3600
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_EXTERNAL_EMAIL_ENABLED: "true"
      GOTRUE_MAILER_AUTOCONFIRM_ENABLED: "true"
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:9999/health"]
      interval: 5s
      timeout: 5s
      retries: 20

  postgrest:
    image: postgrest/postgrest:v12.2.3
    restart: unless-stopped
    depends_on:
      init-db:
        condition: service_completed_successfully
    environment:
      PGRST_DB_URI: postgres://authenticator:${AUTHENTICATOR_PASSWORD}@postgres:5432/${POSTGRES_DB}
      PGRST_DB_SCHEMAS: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: ${JWT_SECRET}
      PGRST_JWT_AUD: authenticated
      PGRST_SERVER_PORT: 3000

  garage:
    image: dxflrs/garage:v2.3.0
    restart: unless-stopped
    environment:
      GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET}
      GARAGE_ADMIN_TOKEN: ${GARAGE_ADMIN_TOKEN}
    volumes:
      - ./docker/garage.toml:/etc/garage.toml:ro
      - garage_meta:/var/lib/garage/meta
      - garage_data:/var/lib/garage/data
    healthcheck:
      test: ["CMD", "/garage", "status"]
      interval: 5s
      timeout: 5s
      retries: 20

  init-db:
    image: postgres:16-alpine
    depends_on:
      postgres:
        condition: service_healthy
      gotrue:
        condition: service_healthy
    environment:
      PGHOST: postgres
      PGUSER: ${POSTGRES_USER}
      PGPASSWORD: ${POSTGRES_PASSWORD}
      PGDATABASE: ${POSTGRES_DB}
    volumes:
      - ./docker/init-db.sh:/init-db.sh:ro
      - ./backend/migrations:/migrations:ro
    entrypoint: ["/bin/sh", "/init-db.sh"]
    restart: "no"

  init-garage:
    image: dxflrs/garage:v2.3.0
    depends_on:
      garage:
        condition: service_healthy
    environment:
      GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET}
      GARAGE_ADMIN_TOKEN: ${GARAGE_ADMIN_TOKEN}
      GARAGE_RPC_HOST: garage:3901
    volumes:
      - ./docker/garage.toml:/etc/garage.toml:ro
      - ./docker/init-garage.sh:/init-garage.sh:ro
      - garage_creds:/secrets
    entrypoint: ["/bin/sh", "/init-garage.sh"]
    restart: "no"

  mike-backend:
    build:
      context: .
      dockerfile: docker/backend.Dockerfile
    image: mike-backend:local
    restart: unless-stopped
    depends_on:
      init-db:
        condition: service_completed_successfully
      init-garage:
        condition: service_completed_successfully
      gotrue:
        condition: service_healthy
    environment:
      PORT: 3001
      FRONTEND_URL: http://${MIKE_HOST}:${MIKE_PORT}
      SUPABASE_URL: http://gotrue:9999
      SUPABASE_SECRET_KEY: ${SUPABASE_SECRET_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      R2_ENDPOINT_URL: http://garage:3900
      R2_BUCKET_NAME: ${R2_BUCKET_NAME}
    volumes:
      - garage_creds:/run/secrets:ro

  mike-frontend:
    build:
      context: .
      dockerfile: docker/frontend.Dockerfile
      args:
        NEXT_PUBLIC_SUPABASE_URL: http://${MIKE_HOST}:${MIKE_PORT}
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY: ${SUPABASE_PUBLISHABLE_KEY}
        NEXT_PUBLIC_API_BASE_URL: http://${MIKE_HOST}:${MIKE_PORT}/backend
    image: mike-frontend:local
    restart: unless-stopped
    depends_on:
      mike-backend:
        condition: service_started

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - gotrue
      - postgrest
      - mike-backend
      - mike-frontend
    environment:
      MIKE_HOST: ${MIKE_HOST}
      MIKE_PORT: ${MIKE_PORT}
    ports:
      - "${MIKE_PORT}:${MIKE_PORT}"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  postgres_data:
  garage_meta:
  garage_data:
  garage_creds:
  caddy_data:
  caddy_config:
```

- [ ] **Step 2: Validate the compose file**

```
cp .env.example .env && ./scripts/generate-secrets.sh
docker compose config --quiet && echo ok
```

Expected: `ok`. Any error means a YAML problem or an unresolved env reference.

- [ ] **Step 3: Commit**

```
git add docker-compose.yml
git commit -m "feat: add docker-compose for self-host stack"
```

---

## Task 11: First-boot smoke test

**Files:**
- (No new files — verifies the assembled stack.)

This task is verification-only. Each step has an explicit pass/fail check. If anything fails, fix it before committing — but most fixes go in earlier tasks' files (Caddyfile, compose, init scripts), then re-run this task.

- [ ] **Step 1: Clean state**

```
docker compose down -v
rm -f .env
cp .env.example .env
./scripts/generate-secrets.sh
$EDITOR .env  # set ANTHROPIC_API_KEY or GEMINI_API_KEY
```

- [ ] **Step 2: Bring up the stack**

```
docker compose up -d --build
```

Expected: builds run for ~3–6 minutes the first time, then all services start. Re-run takes <30s after the first successful boot.

- [ ] **Step 3: Verify all services are healthy**

```
docker compose ps
```

Expected: `postgres`, `gotrue`, `postgrest`, `garage`, `caddy` show `running` with `healthy`. `mike-backend` and `mike-frontend` show `running`. `init-db` and `init-garage` show `exited (0)`.

If any service is unhealthy, inspect its logs with `docker compose logs <service> --tail=100` and fix the relevant earlier task's file.

- [ ] **Step 4: Verify Caddy serves the frontend**

```
curl -sf -o /dev/null -w "%{http_code}\n" http://localhost/
```

Expected: `200`.

- [ ] **Step 5: Verify GoTrue is reachable through Caddy**

```
curl -sf http://localhost/auth/v1/health
```

Expected: a JSON body containing `"name":"GoTrue"` (or similar GoTrue health payload).

- [ ] **Step 6: Verify PostgREST is reachable through Caddy**

```
PUB=$(grep ^SUPABASE_PUBLISHABLE_KEY= .env | cut -d= -f2)
curl -sf -H "apikey: $PUB" -H "Authorization: Bearer $PUB" \
  http://localhost/rest/v1/user_profiles?select=id\&limit=1
```

Expected: JSON `[]` (empty array — anon role has SELECT on the table but RLS blocks rows it doesn't own).

- [ ] **Step 7: Verify Mike's backend is reachable**

```
curl -sf http://localhost/backend/health
```

Expected: `{"ok":true}`.

- [ ] **Step 8: Verify Garage credentials reached the backend**

```
docker compose exec mike-backend printenv R2_ACCESS_KEY_ID R2_BUCKET_NAME R2_ENDPOINT_URL
```

Expected: a non-empty `R2_ACCESS_KEY_ID`, `R2_BUCKET_NAME=mike`, `R2_ENDPOINT_URL=http://garage:3900`.

- [ ] **Step 9: Browser smoke test (manual)**

Open `http://localhost/` in a browser:

1. Sign up with `test@example.com` / a password. Expect to be logged in immediately (autoconfirm is on).
2. Confirm a `user_profiles` row was created:
   ```
   docker compose exec postgres psql -U postgres -d postgres -c "select user_id, tier from user_profiles"
   ```
   Expected: one row.
3. Upload a small `.docx` document. Expect the upload to succeed and the document to appear in the UI.
4. Verify the file landed in Garage:
   ```
   docker compose run --rm init-garage garage bucket info mike
   ```
   Expected: `Objects: 2` or similar (source `.docx` + the converted `.pdf`).
5. Send a chat message that triggers an LLM call. Expect a streaming response from the model whose API key you set.

- [ ] **Step 10: Restart smoke test**

```
docker compose down
docker compose up -d
docker compose ps
```

Expected: all services healthy again within ~30s. The init containers run, see existing state, and exit 0 quickly.

- [ ] **Step 11: Commit a verification note**

No file changes are expected here unless an earlier task needed a fix. If everything passed cleanly, there is nothing to commit and this step is a no-op.

If you did make fixes, amend or add commits to the earlier task they belong to (do not roll smoke-test fixes into a single mega-commit).

---

## Task 12: README self-host section

**Files:**
- Modify: `README.md`

Append a new top-level section describing the docker-compose path. The existing "Setup" section (which covers bare-metal dev) stays intact and remains the source of truth for that workflow.

- [ ] **Step 1: Append the section**

Append to the end of `README.md`:

```markdown
## Self-host with Docker

Single-host docker-compose stack. No managed services required.

### Requirements
- Docker Engine 24+ with Compose v2
- ~4 GB free RAM and ~5 GB free disk for first-time image builds
- An LLM provider key (Anthropic or Google Gemini)

### Bring up

```bash
git clone <this-fork>
cd mike
cp .env.example .env
./scripts/generate-secrets.sh
$EDITOR .env                   # set ANTHROPIC_API_KEY and/or GEMINI_API_KEY
docker compose up -d --build   # ~5 min first time
open http://localhost
```

### Stack

| Service | Role |
|---|---|
| `caddy` | Single ingress on `${MIKE_PORT:-80}`, routes to everything else |
| `postgres` | Database |
| `gotrue` | Authentication (Supabase Auth, self-hosted) |
| `postgrest` | REST layer Mike's frontend uses for `user_profiles` |
| `garage` | S3-compatible object storage for documents |
| `mike-backend` | Express API + LibreOffice (DOCX → PDF) |
| `mike-frontend` | Next.js UI |
| `init-db`, `init-garage` | One-shot bootstrap; run on first boot, exit when done |

### Configuration

- **Port:** edit `MIKE_PORT` in `.env`. Changing it requires `docker compose build mike-frontend` because Next.js bakes URLs at build time.
- **Email confirmation:** off by default (`GOTRUE_MAILER_AUTOCONFIRM=true`). To enable, set it to `false` and add `GOTRUE_SMTP_HOST` / `GOTRUE_SMTP_USER` / `GOTRUE_SMTP_PASS` / `GOTRUE_SMTP_PORT` / `GOTRUE_SMTP_ADMIN_EMAIL` to the `gotrue` service env in `docker-compose.yml`.
- **Reset everything:** `docker compose down -v` deletes all volumes (Postgres data, Garage data, generated Garage credentials, Caddy state).

### What's not included

This compose targets a single trusted host. It deliberately omits TLS, real SMTP, multi-node Garage, secrets-manager integration, and backups. See `docs/superpowers/specs/2026-05-02-self-host-docker-compose-design.md` for the rationale and what each upgrade path looks like.
```

- [ ] **Step 2: Verify Markdown renders**

```
grep -nE "^## " README.md
```

Expected: the existing top-level sections plus the new `## Self-host with Docker`.

- [ ] **Step 3: Commit**

```
git add README.md
git commit -m "docs: document docker-compose self-host workflow"
```

---

## Self-Review

Spec coverage check:

- ✅ Stack & containers (spec §1) → Task 10 (compose) lists all 7 long-lived + 2 one-shot services. Tasks 3, 4, 7, 8 build the supporting artifacts.
- ✅ Caddy ingress (spec §2) → Task 9.
- ✅ Env & secrets (spec §3) → Tasks 1, 2.
- ✅ First-boot bootstrap (spec §4) → Tasks 5, 6.
- ✅ Backend image (spec §5) → Task 7.
- ✅ Frontend image (spec §6) → Task 8.
- ✅ File layout (spec §7) → matches.
- ✅ User experience (spec §8) → README in Task 12.
- ✅ Verification list (spec final section) → Task 11 maps 1:1 to it.

Placeholder scan: none of the steps contain "TBD", "implement later", or hand-wave language. Code blocks accompany every code change. Verification commands have explicit expected outputs.

Type/name consistency:
- `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_ENDPOINT_URL` are spelled identically in `.env.example`, `init-garage.sh`, `backend-entrypoint.sh`, and `docker-compose.yml`'s `mike-backend` env block.
- `GARAGE_RPC_SECRET` and `GARAGE_ADMIN_TOKEN` are spelled identically in `generate-secrets.sh`, `.env.example`, the `garage` service env, and the `init-garage` service env.
- `JWT_SECRET` flows from `.env` → `gotrue` (`GOTRUE_JWT_SECRET`) and → `postgrest` (`PGRST_JWT_SECRET`). Same secret on both, same name in `.env`.
- The frontend build args and the `mike-backend` env both consume `MIKE_HOST` / `MIKE_PORT` consistently.
- `mike-key` and `mike` (bucket name) are spelled identically in `init-garage.sh`.

Refinement made vs. spec (declared up front in this plan): Postgres image switched from `supabase/postgres` to vanilla `postgres:16-alpine`; `init-db` depends on `gotrue` healthy (not just postgres healthy) so `auth.users` exists before Mike's migration runs; `auth.uid()`/`auth.role()` SQL helpers are created by `postgres-init.sh`; `AUTHENTICATOR_PASSWORD` is generated by `generate-secrets.sh` and consumed by both Postgres init and PostgREST.

Plan is internally consistent. Ready to execute.
