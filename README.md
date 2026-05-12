# Mike

Mike is a legal document assistant with a Next.js frontend, an Express backend, Supabase Auth/Postgres, and Cloudflare R2-compatible object storage.

Website: [mikeoss.com](https://mikeoss.com)

## Contents

- `frontend/` - Next.js application
- `backend/` - Express API, Supabase access, document processing, and database schema
- `backend/schema.sql` - Supabase schema for fresh databases
- `backend/migrations/` - incremental database updates for existing deployments

## Prerequisites

- Node.js 20 or newer
- npm
- git
- A Supabase project
- A Cloudflare R2 bucket, MinIO bucket, or another S3-compatible bucket
- At least one supported model provider API key: Anthropic, Google Gemini, or OpenAI
- LibreOffice installed locally if you need DOC/DOCX to PDF conversion

## Database Setup

For a new Supabase database, open the Supabase SQL editor and run:

```sql
-- copy and run the contents of:
-- backend/schema.sql
```

The schema file is based on `supabase-migration.sql` and folds in the later files in `backend/migrations/`.

For an existing database, do not run the full schema file over production data. Apply the incremental files in `backend/migrations/` instead.

## Environment

Create local env files:

```bash
touch backend/.env
touch frontend/.env.local
```

Create `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-service-role-key

R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=mike

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
RESEND_API_KEY=your-resend-key
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret
```

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-supabase-anon-key
SUPABASE_SECRET_KEY=your-supabase-service-role-key
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

Supabase values come from the project dashboard. Use the project URL for `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`, the service role key for `SUPABASE_SECRET_KEY`, and the anon/public key for `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`. If your Supabase project shows multiple key formats, use the legacy JWT-style anon and service role keys expected by the Supabase client libraries.

Provider keys are only needed for the models and email features you plan to use. Model provider keys can be configured in `backend/.env` for the whole instance, or per user in **Account > Models & API Keys**. If a provider key is present in `backend/.env`, that provider is available by default and the matching browser API key field is read-only.

## Install

Install each app package:

```bash
npm install --prefix backend
npm install --prefix frontend
```

## Run Locally

Start the backend:

```bash
npm run dev --prefix backend
```

Start the main app:

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

## First Run

1. Sign up in the app.
2. If you did not set provider keys in `backend/.env`, open **Account > Models & API Keys** and add an Anthropic, Gemini, or OpenAI API key.
3. Create or open a project and start chatting with documents.

## Troubleshooting

**Sign-up confirmation email never arrives.** Confirmation emails are sent by Supabase Auth, not by Mike. For local development, the simplest fix is to disable email confirmation in **Supabase > Authentication > Providers > Email**. For production, configure custom SMTP in Supabase; the built-in mailer is heavily rate-limited and may be restricted on newer projects.

**The model picker shows a missing-key warning.** Add a key for that provider in **Account > Models & API Keys**, or configure the provider key in `backend/.env` and restart the backend.

**DOC or DOCX conversion fails.** Install LibreOffice locally and restart the backend so document conversion commands are available on the process path.

## Useful Checks

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

- **Port:** edit `MIKE_PORT` in `.env`. Changing it requires `./mike build mike-frontend` because Next.js bakes URLs at build time.
- **Email confirmation:** off by default (`GOTRUE_MAILER_AUTOCONFIRM=true`). To enable, set it to `false` and add `GOTRUE_SMTP_HOST` / `GOTRUE_SMTP_USER` / `GOTRUE_SMTP_PASS` / `GOTRUE_SMTP_PORT` / `GOTRUE_SMTP_ADMIN_EMAIL` to the `gotrue` service env in `docker-compose.yml`.
- **Reset everything:** `docker compose down -v` deletes all volumes (Postgres data, Garage data, generated Garage credentials, Caddy state).

### What's not included

This compose targets a single trusted host. It deliberately omits TLS, real SMTP, multi-node Garage, secrets-manager integration, and backups.
