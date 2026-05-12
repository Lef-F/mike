# Mike

Open-source release containing the Mike frontend and backend.

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, Supabase access, document processing, and migrations
- `backend/migrations/000_one_shot_schema.sql` - one-shot Supabase schema for fresh databases

## Setup

Install dependencies:

```bash
npm install --prefix backend
npm install --prefix frontend
```

Create local env files from the examples:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Run `backend/migrations/000_one_shot_schema.sql` in the Supabase SQL editor for a fresh database.

Start the backend:

```bash
npm run dev --prefix backend
```

Start the frontend:

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

## Required Services

- Supabase Auth and Postgres
- S3-compatible object storage, such as Cloudflare R2
- At least one supported model provider key, depending on which models you enable
- LibreOffice for DOC/DOCX to PDF conversion

## Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```

## License

AGPL-3.0-only. See `LICENSE`.

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
./mike up -d --build           # ~5 min first time
open http://localhost
```

### Deployment modes

Mike's compose stack supports six deployment combinations selected by two
env vars in `.env`:

| `MIKE_SUPABASE_MODE` | `MIKE_STORAGE_MODE` | What runs in-cluster | What you provide |
| --- | --- | --- | --- |
| `bundled-full` (default) | `bundled` (default) | Everything | Nothing |
| `bundled-full` | `external` | Postgres, GoTrue, PostgREST | R2/S3 endpoint + creds |
| `bundled-byo-db` | `bundled` | GoTrue, PostgREST, Garage | `EXTERNAL_POSTGRES_URL` |
| `bundled-byo-db` | `external` | GoTrue, PostgREST | External PG + R2/S3 |
| `external` | `bundled` | Garage | Hosted Supabase keys |
| `external` | `external` | (nothing optional) | Hosted Supabase + R2/S3 |

Switching modes:
1. Edit `MIKE_SUPABASE_MODE` and/or `MIKE_STORAGE_MODE` in `.env`.
2. Set the matching `EXTERNAL_*` values (see `.env.example` for the
   full list and which mode requires which).
3. Run `./scripts/generate-secrets.sh` to fill in only the secrets the
   new mode needs (warns about missing operator-supplied values).
4. **If switching to/from `external` Supabase mode**, you also need to
   rebuild the frontend image: the Supabase URL is baked at build time.
   `./mike build mike-frontend` does this.
5. `./mike up -d`.

The `./mike` wrapper reads the modes from `.env`, validates them, and
forwards to `docker compose` with the right `--profile` flags. Run
`./mike --print-profiles` to see what flags will be used.

#### Hosted Supabase (`external`) migration note

When `MIKE_SUPABASE_MODE=external`, set `EXTERNAL_SUPABASE_PG_URL` to
the Postgres connection string from Supabase's Project Settings →
Database → "Connection string". Mike's `init-db` service will apply
the schema migrations against the hosted DB on first `./mike up`
(idempotent — safe to re-run).

#### Smoke test

`scripts/smoke-test.sh` brings the default-mode stack up, waits for
Caddy on `${MIKE_PORT:-80}`, hits the frontend + backend, and tears
down. Useful as a CI/post-rebase sanity check.

```bash
./scripts/smoke-test.sh
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
