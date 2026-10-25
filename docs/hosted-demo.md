# Limited Free Hosted Demo

This is a shared, fictional demonstration, not production or an always-on pilot. The deployment definition is ready for a live infrastructure trial; no public service has been deployed.

## Architecture

- One Render **Free** Docker web service, using `Dockerfile.render` and `render.yaml`.
- Production-built Next listens on Render's public `PORT` (default 10000). Its same-origin `/api/v1` rewrite reaches Fastify at `127.0.0.1:4000`.
- Fastify and seed run with explicit `NODE_ENV=development`, `DEMO_MODE=true`, `HOSTED_DEMO=true`. Existing production rejection of demo authentication remains intact.
- Supabase PostgreSQL and a private S3-compatible bucket hold persistent data. No Render database or persistent disk.
- No Redis or worker is started. Notifications remain pending; notification delivery, scheduled reminders and automatic SLA escalation do not run. Request-time metrics and manual workflows still work.

`NEXT_PUBLIC_HOSTED_DEMO=true` is a presentation-only build flag. It exposes the five seeded role shortcuts and visible demo warnings; it never enables backend authentication. Ordinary production builds retain the existing demo-shortcut guard.

## Required Decisions

Both provider APIs were accessible on 2026-10-25. Render's `My Workspace` had no services. Supabase's `Swacttrack` project had four existing public tables; `Swact` had no public tables. Neither project was changed. Empty public schema does not prove an entirely unused project or free billing plan.

Before provisioning, confirm which dedicated project to use and its free plan. Obtain permission to create/upload a private source repository, or use an explicitly supplied repository. Never overwrite `Swacttrack`, delete another project to free a slot, upgrade a plan, or push code without authorization.

## Database And Storage

1. Use a dedicated empty database. Prefer Supabase's session pooler on port 5432 when direct IPv6 connectivity is unavailable. Copy the exact connection string from the provider, require TLS, and start with a small Prisma connection pool. Do not use transaction-pooler port 6543 for migrations without deliberate separate migration configuration.
2. This application uses Prisma, not Supabase's Data API. Disable the Data API for the dedicated project, or isolate/revoke public access to the application tables before applying migrations. Existing Fastify tenant checks do not secure a separate exposed REST API; the migrations do not add Supabase RLS policies.
3. Precreate a **private** bucket. Copy the Supabase S3 endpoint (including `/storage/v1/s3`), region, and generated S3 access key/secret. These keys bypass Storage RLS; never expose them to the browser. Do not substitute anon/service-role JWTs for S3 credentials.
4. Configure both `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT`; for Supabase they normally have the same HTTPS value. The startup preflight requires both explicitly. Confirm real browser upload/read behavior; Supabase does not support the generic S3 `PutBucketCors` operation.
5. Verify an unsigned object URL cannot read an object, while the application's authenticated short-lived signed read succeeds. `HeadBucket` proves accessibility, not privacy or CORS.

## Render Configuration

Create only the service in `render.yaml`; its `plan` is `free`. Do not add a background worker, Redis, disk, paid database or paid pre-deploy command. Confirm the account's free allowance before submitting creation.

| Setting | Value |
| --- | --- |
| `HOSTED_DEMO`, `DEMO_MODE` | `true`, `true` |
| `STORAGE_DRIVER` | `s3` |
| `DATABASE_URL` | Dedicated database URL, server-side secret |
| `JWT_SECRET`, `QR_SECRET` | Independent generated values, at least 32 characters; keep stable |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT` | Provider's HTTPS S3 endpoint |
| `S3_REGION`, `S3_BUCKET` | Exact dedicated resource values |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Provider-generated S3 credentials, server-side secrets |
| `API_PUBLIC_URL` | Optional explicit HTTPS origin; defaults to Render's `RENDER_EXTERNAL_URL` |

Build-time Next flags and internal rewrite are fixed in `Dockerfile.render`. The launcher derives CORS from the public origin, keeps Fastify on loopback, and removes database/signing/storage secrets from the Next child environment. Health path: `/api/v1/readyz` (web proxy + API + database, not S3/provider acceptance).

Startup runs S3 **check-only**, `prisma migrate deploy`, compact seed, API readiness, then Next. Missing configuration/bucket, failed migrations/seed, readiness timeout or an unexpected child exit fail closed. Signals stop child process groups with a bounded force-kill fallback. No reset or public initialization endpoint exists.

## Compact Fixtures

Hosted seed: five primary societies, 30 properties, seven historical days, 210 pickup events, 24 dated routes / 240 stops, 408 synthetic photos and five documents. Five seeded login identities are permitted; altered users/memberships, unseeded users and profile/invitation/deactivation mutations are rejected. Visitors can still change shared fictional business records.

The default local seed remains 240 properties and 7,200 historical events. Hosted seed refuses incompatible standard-profile or tenant data, can resume partial initialization, and skips completed seeds without overwriting edits. It does not refresh dates or restore deleted objects on every restart. Use only fictional uploads; seed completion does not guarantee indefinite free storage under public traffic.

## Executed Checks

2026-10-25: fresh disposable local PostgreSQL 16; all three migrations; lint; six package typechecks; **29 files / 436 tests / zero skips**. This includes 26 core API tests, 38 hosted-auth integration tests, 22 seed tests and 68 deployment tests. Test databases were dropped after verification; existing `swachh` was not reset.

Production Next build with hosted UI enabled passed. Compact-demo browser acceptance passed **11/11** checks. Offline S3-signing tests demonstrate that presigned PUT no longer carries an empty-body CRC32 checksum. Application image normalization and SHA-256 hashing remain unchanged.

`tests/hosted-demo.e2e.mjs` records compact-demo browser acceptance separately in `outputs/hosted-demo-e2e.json`: five role logins, visible notices, Hindi, responsive layouts, hidden identity controls, API mutation rejection and real **local-storage** image upload/confirmation/read. It requires disposable fixtures and a real browser; it is not an S3, Docker or public deployment test. Earlier 10-scenario standard-profile evidence remains separate in `outputs/web-e2e.json`.

To run all seed tests, set `SEED_TEST_ADMIN_DATABASE_URL` to an explicit disposable local PostgreSQL admin connection with create/drop database permission. Never run the suites against managed/user data. CI now supplies this test-only setting; the authored GitHub workflow itself has not been executed here.

## Still Required Before Sharing A Live URL

- Actual Docker image build and combined-service run; Docker is unavailable in this worker.
- Real Supabase migration, seed, private S3 upload/confirmation/download and CORS/unsigned-access checks.
- Real Render deployment, restart/reseed safety, wake-up time and peak memory under its Free limit. First seed performs hundreds of storage writes, so measure cold-start time.
- Free-plan/allowance verification for the chosen accounts and project.
- Native Android/500-event sync and production SMS/WhatsApp/FCM/malware scanning remain outside this demo's acceptance.

Render may sleep after inactivity; Supabase may pause inactive free projects. No artificial keepalive or uptime guarantee is provided. Provider references: [Render Free](https://render.com/docs/free), [Supabase pricing](https://supabase.com/pricing), [database connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication), [S3 compatibility](https://supabase.com/docs/guides/storage/s3/compatibility).
