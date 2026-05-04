# Self-Hosted Docker Compose for Mike

**Date:** 2026-05-02
**Status:** Approved (pending user review of this written spec)
**Target:** Local laptop / single-host self-hosting with one-command bring-up.

## Goal

Make this fork of Mike runnable on a single machine via `docker compose up`, with no managed services. The user clones the fork, sets a couple of secrets and at least one LLM provider key, and gets a working Mike at `http://localhost`.

Out of scope for this design:
- Multi-host or 3-node Garage cluster.
- TLS certificates and public DNS.
- SMTP / real email confirmation flows.
- Production hardening (secrets manager, backups, monitoring).

These are deliberately deferred so the first cut stays small. The compose is designed so each of those is an additive change later, not a refactor.

## High-level shape

A single `docker-compose.yml` at the fork root brings up:

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2-alpine` | Single ingress on `${MIKE_PORT:-80}`, path-routes to everything else. |
| `postgres` | `supabase/postgres:15.6.1.115` | Database. Uses Supabase's image so the extensions and roles GoTrue/PostgREST need are already present. |
| `gotrue` | `supabase/gotrue:v2.166.0` | Authentication (issues and verifies the JWTs Mike's backend already validates). |
| `postgrest` | `postgrest/postgrest:v12.2.3` | REST layer over Postgres, only used by the frontend for `user_profiles`. |
| `garage` | `dxflrs/garage:v2.3.0` | S3-compatible object storage, `replication_factor = 1`. |
| `mike-backend` | built from `docker/backend.Dockerfile` | Express API + LibreOffice. |
| `mike-frontend` | built from `docker/frontend.Dockerfile` | Next.js, standard `next start`. |
| `init-db` (one-shot) | `postgres:15-alpine` | Applies the schema migration. |
| `init-garage` (one-shot) | `dxflrs/garage:v2.3.0` | Creates the Mike bucket + access key. |

Seven long-lived containers plus two one-shots. No Studio, Realtime, Kong, Vector, Logflare, Edge Runtime, Supabase Storage, or MinIO.

Image tags above (Postgres, GoTrue, PostgREST, Garage) are indicative; the implementation plan pins the latest stable releases at the time of writing.

## Why this shape

Mike's actual surface against Supabase is small enough that the full Supabase compose is overkill:

- Backend uses `@supabase/supabase-js` only to verify bearer tokens (`admin.auth.getUser`). That's GoTrue.
- Frontend uses `@supabase/auth-js` for `signUp`, `getSession`, `onAuthStateChange`, `signOut` (GoTrue) and direct `from('user_profiles')` reads/writes (PostgREST).
- No `.channel()` / `.subscribe()` calls in the frontend → Realtime is unused.
- Backend talks to S3 directly via `@aws-sdk/client-s3` with a custom endpoint → Supabase Storage is unused.

The slim stack covers everything Mike actually touches and skips the rest.

## Ingress (Caddy) routing

Browser-facing URLs are normalised onto a single host:port to avoid CORS, simplify cookies, and make a future TLS upgrade a one-line change.

```
{$MIKE_HOST}:{$MIKE_PORT} {
    handle_path /auth/v1/* { reverse_proxy gotrue:9999 }
    handle_path /rest/v1/* { reverse_proxy postgrest:3000 }
    handle_path /backend/* { reverse_proxy mike-backend:3001 }
    handle                 { reverse_proxy mike-frontend:3000 }
}
```

`handle_path` strips the prefix before forwarding, so the upstream services see clean paths. The frontend gets the catch-all.

This produces:

- `http://${MIKE_HOST}:${MIKE_PORT}/` → Mike UI
- `http://${MIKE_HOST}:${MIKE_PORT}/auth/v1/...` → GoTrue
- `http://${MIKE_HOST}:${MIKE_PORT}/rest/v1/...` → PostgREST
- `http://${MIKE_HOST}:${MIKE_PORT}/backend/...` → Mike API

The `/auth/v1` and `/rest/v1` prefixes match the standard Supabase URL shape, so `@supabase/auth-js` and `@supabase/supabase-js` work unchanged with `NEXT_PUBLIC_SUPABASE_URL=http://${MIKE_HOST}:${MIKE_PORT}`.

The `/backend/` prefix avoids colliding with Next.js's own `/api/*` namespace (Mike's `next.config.ts` already maps `/sitemap.xml` to an internal `/api/sitemap/...` route).

Garage's S3 endpoint stays internal — only `mike-backend` and the `init` container talk to it. It is intentionally not exposed via Caddy.

## Environment & secrets

A single root `.env` file is the source of truth for the compose stack. The existing `backend/.env.example` and `frontend/.env.local.example` are kept untouched; they remain accurate for the bare-metal dev path documented in the upstream README.

`.env.example` (annotated):

```
# --- Ingress ---
MIKE_HOST=localhost
MIKE_PORT=80

# --- Postgres ---
POSTGRES_PASSWORD=<generate>
POSTGRES_DB=postgres

# --- Supabase keys (filled by scripts/generate-secrets.sh) ---
JWT_SECRET=<32+ random chars>
SUPABASE_PUBLISHABLE_KEY=<JWT signed with JWT_SECRET, role=anon, exp=10y>
SUPABASE_SECRET_KEY=<JWT signed with JWT_SECRET, role=service_role, exp=10y>

# --- GoTrue (laptop defaults) ---
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_DISABLE_SIGNUP=false

# --- LLM provider keys (at least one) ---
ANTHROPIC_API_KEY=
GEMINI_API_KEY=

# --- Garage (populated by the init container; do not edit by hand) ---
R2_ENDPOINT_URL=http://garage:3900
R2_BUCKET_NAME=mike
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

`scripts/generate-secrets.sh` is a small POSIX shell script that:

1. Generates `JWT_SECRET` (32+ random bytes, hex).
2. Mints two long-lived JWTs (`role=anon` and `role=service_role`) signed with that secret. Implementation: a small inline node one-liner using `node -e` plus `crypto.subtle`, or `openssl` + `jose-cli` if available — kept dependency-free where possible. The exact implementation is a planning detail.
3. Writes them into `.env` if not already set; refuses to overwrite existing values without `--force`.

Email confirmation defaults to **off** (autoconfirm). Turning it on later means setting `GOTRUE_MAILER_AUTOCONFIRM=false` plus the standard `SMTP_*` / `GOTRUE_SMTP_*` env vars; no compose changes required.

## First-boot bootstrap

Two one-shot containers handle the work that has to happen exactly once on a fresh stack. Each depends on its target service being healthy, runs to completion, and exits 0. Steps are idempotent so subsequent `up`s are no-ops apart from a few seconds of validation.

### `init-db`

Image: `postgres:15-alpine` (already includes `psql`).

1. **Wait** for Postgres via `pg_isready`.
2. **Apply schema:** `psql "$DATABASE_URL" -f /migrations/000_one_shot_schema.sql`. The migration uses `create ... if not exists` and `drop trigger if exists` throughout, so re-running it is safe.
3. **Bootstrap PostgREST roles:** ensure the `anon` and `authenticated` Postgres roles exist with the grants PostgREST and the RLS policies expect. (Supabase normally seeds these via Studio/migrations; we do it explicitly.) Idempotent.
4. Exit 0.

### `init-garage`

Image: `dxflrs/garage:v2.3.0` — the same image as the `garage` service, so the `garage` CLI is available. The container is given the same `rpc_secret` and points its CLI at `garage:3901` (cluster RPC port, internal-only).

1. **Wait** for Garage's admin API at `http://garage:3903/health` to return 200.
2. **Create bucket + key + grant:**
   - `garage bucket create mike` (ignore "already exists")
   - `garage key create mike-key` (or fetch existing key info)
   - `garage bucket allow --read --write --owner mike-key mike`
3. **Persist credentials** by writing `R2_ACCESS_KEY_ID=...` / `R2_SECRET_ACCESS_KEY=...` to `/secrets/garage.env` on a named docker volume (`mike_garage_creds`).
4. Exit 0.

### Wiring into the backend

The named volume `mike_garage_creds` is also mounted read-only into `mike-backend` at `/run/secrets`. `docker/backend-entrypoint.sh` sources `/run/secrets/garage.env` before exec-ing the Node CMD, populating `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` at runtime. The user never edits these.

`mike-backend.depends_on` lists both init containers with `condition: service_completed_successfully`.

## Backend image (`docker/backend.Dockerfile`)

Multi-stage. Build stage compiles TypeScript; runtime stage adds LibreOffice.

```
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY docker/backend-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
```

`backend-entrypoint.sh` sources `/run/secrets/garage.env` (written by the `init` container) before exec-ing the CMD. This is what wires the Garage credentials at runtime without baking them into the image or the user's `.env`.

Only `libreoffice-core` and `libreoffice-writer` (plus Liberation fonts) are installed — Mike's `convert.ts` only converts DOCX → PDF, so we don't need Calc/Impress/Draw. Saves ~800 MB versus full `libreoffice`.

## Frontend image (`docker/frontend.Dockerfile`)

Standard Next.js build (no OpenNext / Cloudflare path — that's the upstream cloud deploy target, not this self-host one).

```
FROM node:22-bookworm-slim AS build
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ARG NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
EXPOSE 3000
CMD ["npm","run","start"]
```

The compose service passes `NEXT_PUBLIC_*` through `args:`, derived from `MIKE_HOST` and `MIKE_PORT`:

```
NEXT_PUBLIC_SUPABASE_URL=http://${MIKE_HOST}:${MIKE_PORT}
NEXT_PUBLIC_API_BASE_URL=http://${MIKE_HOST}:${MIKE_PORT}/backend
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=${SUPABASE_PUBLISHABLE_KEY}
```

**Trade-off:** Next.js bakes `NEXT_PUBLIC_*` at build time, so changing `MIKE_HOST` or `MIKE_PORT` after the first build requires `docker compose build mike-frontend` (or `docker compose up --build`). Documented in the README. The alternative — switching to Next.js standalone output and computing the Supabase URL from `window.location.origin` at runtime — requires a code change in `frontend/src/lib/supabase.ts` and is deferred.

## File layout in the fork

```
mike/
├── docker-compose.yml         # new
├── .env.example               # new (root-level, for the compose stack)
├── Caddyfile                  # new
├── docker/                    # new
│   ├── backend.Dockerfile
│   ├── backend-entrypoint.sh
│   ├── frontend.Dockerfile
│   ├── garage.toml
│   ├── postgres-init.sql      # roles/grants for GoTrue & PostgREST
│   ├── init-db.sh             # apply schema migration
│   └── init-garage.sh         # create bucket/key, write creds
├── scripts/                   # new
│   └── generate-secrets.sh
├── backend/                   # untouched
├── frontend/                  # untouched
└── README.md                  # appended with a "Self-host with Docker" section
```

The existing `backend/.env.example` and `frontend/.env.local.example` are not touched — they remain the source of truth for the bare-metal dev path that's already documented.

## User experience

```
git clone <fork>
cd mike
cp .env.example .env
./scripts/generate-secrets.sh    # fills JWT_SECRET, SUPABASE_*_KEY in .env
$EDITOR .env                     # set ANTHROPIC_API_KEY or GEMINI_API_KEY
docker compose up -d             # ~5 min first time
open http://localhost
```

Three commands plus an editor visit. Subsequent `up`s are <30s.

## Ports & networking

- `${MIKE_PORT:-80}` is the only port exposed to the host. Caddy listens on it.
- All other services communicate over the default compose bridge network (`mike_default`) by service name.
- Postgres is **not** exposed to the host. If a user wants `psql` access, they use `docker compose exec postgres psql ...`.
- Garage's three internal ports stay internal: S3 API (`3900`), cluster RPC (`3901`), admin API (`3903`). None are published to the host.

## Healthchecks & dependency order

Roughly:

- `postgres` healthcheck: `pg_isready`.
- `garage` healthcheck: HTTP 200 on `http://localhost:3903/health` (admin API, container-local).
- `init-db`: `depends_on: postgres (service_healthy)`.
- `init-garage`: `depends_on: garage (service_healthy)`.
- `gotrue`, `postgrest`: `depends_on: postgres (service_healthy), init-db (service_completed_successfully)`.
- `mike-backend`: `depends_on: init-db (service_completed_successfully), init-garage (service_completed_successfully), gotrue (service_started)`.
- `mike-frontend`: `depends_on: mike-backend (service_started)`.
- `caddy`: depends on the four browser-facing services (`gotrue`, `postgrest`, `mike-backend`, `mike-frontend`); Caddy tolerates upstream churn so this is just for cleaner first-start logs.

## Open trade-offs explicitly accepted

1. **Frontend rebuild on URL change.** Changing `MIKE_HOST` or `MIKE_PORT` requires `docker compose build mike-frontend`. Acceptable for the laptop target; revisit if/when we add a domain.
2. **No Studio.** Database is opaque from the browser by default. Acceptable; can be added later behind a `--profile admin` opt-in (one extra service in compose).
3. **No SMTP.** Signups auto-confirm. Acceptable for self-host trust model; flip one env var + supply SMTP creds to enable.
4. **Single-node Garage.** No redundancy. Acceptable for laptop; revisit if/when we target a real host.
5. **Two `.env.example` files coexist.** The root one is for compose; the per-app ones are for bare-metal dev. They serve different audiences — keeping both is clearer than merging.
6. **Vestigial deps not removed.** `resend` and `@openrouter/sdk` are unused but stay in `package.json` to keep the fork's diff against upstream small. Out of scope here.

## What's deliberately not in this design

- No CI workflow changes.
- No tests for the compose stack itself (manual smoke test on first run is the verification).
- No removal of `nixpacks.toml` (it's still useful for the upstream Railway-style deploy path).
- No production secrets-manager integration.
- No backup / restore tooling for Postgres or Garage.
- No upgrade-path documentation for moving between GoTrue / PostgREST / Garage versions.

These are real concerns for a production deployment but explicitly out of scope for the laptop target.

## Verification (when implementation is done)

The implementation is considered complete when, on a clean clone:

1. `cp .env.example .env && ./scripts/generate-secrets.sh && $EDITOR .env` (set one LLM key) followed by `docker compose up -d` results in all containers reaching healthy/running.
2. `http://localhost` serves the Mike UI.
3. Signing up at `/signup` creates a row in `auth.users` and `public.user_profiles`.
4. Logging in, opening the app, and uploading a `.docx` succeeds: file lands in Garage at `documents/<userId>/<docId>/source.docx` and a generated `.pdf` lands at `documents/<userId>/<docId>/<stem>.pdf`.
5. Sending a chat message that hits Anthropic or Gemini returns a response.
6. `docker compose down && docker compose up -d` brings everything back without re-running migrations or re-creating the bucket.
