# Swachh-Track

An evidence-first municipal waste-collection pilot: an Android-first Expo collector app, a role-scoped web console, and a Fastify/PostgreSQL API. This repository implements the workflows below, not a production-certified civic platform.

## Current Evidence

**Limited free-demo update, 2026-10-25:** single-service Render configuration, guarded compact seed, five-role hosted UI and upload-signing fix are implemented. Fresh local verification passed **29 files / 436 tests / zero skips**, lint, all six package typechecks and the production web build. Both provider APIs are accessible, but **no public deployment** has been created. See [hosted-demo setup and remaining gates](docs/hosted-demo.md). The earlier standard-profile results below remain a separate snapshot.

Latest verification on **2026-10-25**: Node 22 / pnpm 10.11.0 dependencies installed; Prisma schema validated; fresh local PostgreSQL **16.15** restored, all three migrations applied, and fictional seed completed with 240 properties and 7,200 historical events. `pnpm check` passed at **04:33 UTC**, including lint, all six workspace packages' typechecks and **23 files / 262 tests / 0 skips**, with **26 real PostgreSQL integration tests**. The web production build passed around **04:36 UTC**; Expo dependency compatibility passed with Expo 54.0.37, expo-crypto 15.0.9 and expo-file-system 19.0.24.

Provisioned Chromium with Node Playwright passed **10/10 browser scenarios**, recorded at **04:37:17.015 UTC** in [outputs/web-e2e.json](outputs/web-e2e.json), against production-built Next and a development/demo API through a private request bridge. The final run used a fresh, separate disposable database, `swachh_browser_acceptance`, to avoid OTP-limit exhaustion from repeated development tests, not a reset of user data. Redis **7.0.15** worker smoke persisted **22 `DELIVERED` notifications and 22 attempt rows**; retries/failures and native/external messaging were not proven. Indexed domain metrics preserved exact baseline output on 7,200 events / 7,440 stops; dashboard median over 15 runs improved from **723.1 to 92.6 ms**, not an HTTP or Android benchmark.

**M8 remains partial, not production acceptance.** Docker/Compose, S3/MinIO, physical Android/Maestro and the 500-event sync performance target are **not verified**; production SMS/WhatsApp/FCM and malware scanning are absent. There is **no public deployment**: the private test origin is not a public URL, and worker-local processes do not survive task completion. See [acceptance](docs/acceptance.md) for exact scenario boundaries and evidence paths.

## Implemented Scope

| Area                | Current code                                                                                                                         | Boundary                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Identity            | OTP, memberships, scoped roles, refresh rotation, device binding                                                                     | Fixed OTP only in development/demo; production SMS provider absent                                           |
| Registry            | Properties/CSV import, signed QR sheets, resident links, schedules, vendors, dated ordered routes                                    | Manual route ordering; no route optimization                                                                 |
| Collection          | Camera/GPS/manual kg, SQLite drafts and queue, staged uploads, idempotent sync, supervisor review                                    | Native device/restart/performance acceptance outstanding                                                     |
| Resident/operations | Pickup evidence, verified-only ratings, complaints, resolution photos, SLA history, notifications                                    | External messaging is not delivered                                                                          |
| Billing             | Monthly draft/issue, evidence lines, PDF, manual partial/full payment, disputes, accounts CSV                                        | No payment gateway, tax certification or automated dispute settlement                                        |
| Compliance          | Eligibility inputs, registration records, document vault, external certificate ledger, handovers, onsite logs, annual draft JSON/PDF; inspection PDF merges stored PDF/JPEG evidence and invoice PDFs | Not a government submission or legal determination; missing records remain explicit and undecodable evidence fails the pack |
| ULB console         | Scoped dashboards, ward/society maps, contractor metrics, audit and CSV/XLSX/PDF exports                                             | Maps use recorded coordinates and fictional seed boundaries; no realtime vehicle tracking                    |
| Vehicles            | Prisma `Vehicle` model and optional route reference                                                                                  | Standalone vehicle management API/UI omitted                                                                 |
| Privacy             | Retention settings and export/erasure requests for review                                                                            | No destructive retention or erasure executor                                                                 |

Billing (`billing_v1`) and compliance (`compliance_v2`) are enabled for the fictional demo tenant. Missing flags mean disabled for other tenants. `whatsapp_v1` and `swachhata_v1` are off in the seed; turning them on does not configure a provider. Feature-flag changes require `SUPER_ADMIN`; the five primary demo accounts do not include that role.

## Local Setup

Run commands from the repository root. Use Node **22.x**, Corepack, pnpm **10.11.0**, PostgreSQL **16**, and Redis **7** for the worker. Plain PostgreSQL is sufficient for current migrations and queries; PostGIS is optional, not used by the application. Android builds additionally need the Android SDK, JDK 17 and a compatible device.

```sh
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm --version
pnpm install --frozen-lockfile
test -f .env || cp .env.example .env
node -e "const {randomBytes}=require('node:crypto'); for (const key of ['JWT_SECRET','QR_SECRET']) console.log(key+'='+randomBytes(48).toString('hex'))"
```

Only copy the template if `.env` does not already exist. Put the two independently generated values in `.env`; **never use the `CHANGE_ME` placeholders as secrets**, even though they satisfy the length check. Generate separate random database and MinIO credentials, for example with `node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"`. Keep `POSTGRES_PASSWORD` and the password in `DATABASE_URL` consistent. Hex avoids URL-encoding surprises. Do not commit `.env` or expose demo services to the public internet.

Choose one storage/infrastructure path below. `scripts/local-env.mjs` is an environment-specific provisioning helper, not a portable installation command.

### Host Processes With Local Storage

Provision an empty PostgreSQL database and Redis locally. Set `DATABASE_URL` to that database, `REDIS_URL` to Redis, and use these overrides in `.env`:

```dotenv
NODE_ENV=development
DEMO_MODE=true
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=apps/api/.storage
API_PUBLIC_URL=http://localhost:4000
API_INTERNAL_URL=http://localhost:4000
NEXT_PUBLIC_API_URL=/api/v1
NEXT_PUBLIC_DEMO_MODE=true
CORS_ORIGINS=http://localhost:3000
```

Local storage is the path exercised by the real-image integration tests. It does not need MinIO. The API resolves its root `.env` and relative storage path even when started with a package filter.

```sh
pnpm db:generate
pnpm exec prisma validate
pnpm db:migrate
pnpm db:seed
export NEXT_PUBLIC_DEMO_MODE=true
pnpm dev
```

`pnpm dev` starts API, Next development server and Expo together. Start the notification worker in a **separate terminal**:

```sh
pnpm --filter @swachh/api worker
```

For separate terminals or a web-only demo:

```sh
pnpm --filter @swachh/api dev
pnpm --filter @swachh/web dev
pnpm --filter @swachh/collector start
```

Each of those is a long-running process. Open web at `http://localhost:3000`, API at `http://localhost:4000/api/v1`, Swagger UI at `http://localhost:4000/docs`, and generated OpenAPI JSON at `http://localhost:4000/docs/json`.

Next runs from `apps/web`, so export web overrides such as `NEXT_PUBLIC_DEMO_MODE` or `API_INTERNAL_URL` in its shell, or put them in `apps/web/.env.local`; do not assume it loads the root `.env`. Its default API rewrite already targets localhost:4000. Set public variables before the web build, and restart/rebuild after rewrite changes. Compose supplies its web environment explicitly.

```sh
curl --fail http://localhost:4000/api/v1/healthz
curl --fail http://localhost:4000/api/v1/readyz
```

Readiness checks PostgreSQL only, not Redis, storage or providers. `pnpm build` builds the web app only; it does not produce an Android binary or test the worker.

### Docker Compose Alternative

**Authored, not runtime-tested in this environment:** Docker was unavailable. Install Docker with Compose v2 elsewhere, complete every `.env` placeholder, retain the template's S3 settings, then run:

```sh
docker compose up --build
```

Compose defines PostGIS/PostgreSQL 16, Redis 7.4.3, MinIO, and a one-shot `migrate` service that runs `db:migrate`, `storage:init`, then `db:seed`. API and worker wait for successful initialization; web waits for API readiness. The Dockerfile installs the frozen workspace and generates Prisma. It runs the API through `tsx`; Compose runs Next in **development** mode and forces `NODE_ENV=development`. This is a demo stack, not a hardened production image.

Compose uses internal `postgres`, `redis` and `minio` hostnames; do not put those in a phone's URL. PostgreSQL/Redis ports bind loopback, while web/API/MinIO data ports are exposed on the host. Use a firewall and isolated demo network. Expo is not a Compose service: run it on the host after installing dependencies. Avoid running a second host API/web on the same ports.

For host-run S3 instead of local storage, configure MinIO/S3 and run `pnpm --filter @swachh/api storage:init` before `pnpm db:seed`. The bucket initializer does not configure browser CORS; configure allowed origins and PUT/GET headers separately for browser uploads. Keep the bucket private. S3 interoperability remains untested.

### Android Connectivity And Location

For a physical Android phone on Wi-Fi, export a reachable **LAN** address before starting Expo; ordinary phone `localhost` refers to the phone, not the API computer:

```sh
EXPO_PUBLIC_API_URL=http://192.168.1.20:4000/api/v1 pnpm --filter @swachh/collector start
```

Replace the example address with the API host's address. For local storage set `API_PUBLIC_URL=http://192.168.1.20:4000` and restart API. For MinIO set `S3_PUBLIC_ENDPOINT=http://192.168.1.20:9000`. Signed image URLs must also be reachable from the phone and browser. The Android emulator normally uses `10.0.2.2`; USB `adb reverse` is an alternative described in [collector notes](apps/collector/README.md). A root `.env` is not a guarantee that Expo receives its public variable; export it or use `apps/collector/.env`.

```sh
pnpm --filter @swachh/collector check:expo
pnpm --filter @swachh/collector android
```

Use a compatible SDK 54 Expo Go for development, or the installed native app `in.swachhtrack.collector` for Maestro. Neither path has been physically validated here.

Seed coordinates are fictional Pune-area points near `18.5204, 73.8567`. A phone elsewhere should fail the 75 m geofence. Before a physical demo, create/update **test** property coordinates to the actual test site, create today's route from valid schedules/vendor/collector, and refetch the route on the phone. Do not spoof GPS or weaken the geofence to make a demo pass. See the [ten-minute demo](docs/demo-script.md).

## Fictional Demo Accounts

Request an OTP, then enter `123456`. This is accepted only with **both** `NODE_ENV=development` and `DEMO_MODE=true`; no SMS is sent. Aliases are accepted in the API's `phone` field only under that gate. The phone values are synthetic identifiers, not numbers to contact.

| Role          | Phone           | Alias                            |
| ------------- | --------------- | -------------------------------- |
| Resident      | `+919000000001` | `resident@demo.swachhtrack.in`   |
| Society admin | `+919000000002` | `society@demo.swachhtrack.in`    |
| Collector     | `+919000000003` | `collector@demo.swachhtrack.in`  |
| Supervisor    | `+919000000004` | `supervisor@demo.swachhtrack.in` |
| ULB admin     | `+919000000005` | `ulb@demo.swachhtrack.in`        |

The resident is linked to Green Meadows, block A, unit 101. The seed also supplies five more collectors, two contractors, five named societies, two primary wards, three routes dated on seed day and 30 days of historical scenarios, plus an isolated second tenant. `DEMO_SYNTHETIC` evidence is not field-verified household collection, even when its scenario status is `VERIFIED`.

The completed seed is repeat-safe and does not overwrite data or advance today's routes on later runs. Create new dated routes when the demo day changes. Do not rotate signing secrets after seeding without regenerating property QR hashes/sheets and refreshing cached routes. `pnpm db:reset` is destructive and must never target pilot or production data.

## Verification And Reading

Use a disposable migrated database for `pnpm test`. The integration suite uses `TEST_DATABASE_URL` if set, otherwise `DATABASE_URL`; without either it skips. A passing unit-only run is not database acceptance.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @swachh/collector check:expo
```

`pnpm check` migrates and seeds before lint/typecheck/test; it is not read-only. The authored [CI workflow](.github/workflows/ci.yml) runs these core gates against synthetic PostgreSQL fixtures. It does not claim browser, Android, MinIO or worker acceptance.

Browser source is [tests/web.e2e.mjs](tests/web.e2e.mjs); `pnpm e2e` invokes [scripts/e2e.mjs](scripts/e2e.mjs). The runner accepts `E2E_CDP_URL`, `E2E_REUSE_PAGE` and `E2E_BASE_URL`; see [tests/README.md](tests/README.md) for their exact behavior. Hosted cloud browser interactions must use `browser_execute` with the provisioned browser and `.bcode/agent-workspace/hosted-e2e.mjs` private bridge, never a local browser launch. Local Playwright installation/launch is supported only for ordinary external development machines.

- [Architecture](docs/architecture.md): components, trust boundaries, data flow and limitations.
- [API](docs/api.md): actual routes, authentication, upload and sync contracts.
- [Compliance](docs/compliance.md): implemented calculations, evidence provenance and legal boundaries.
- [Security](docs/security.md): controls, remaining risks and deployment checklist.
- [Demo Script](docs/demo-script.md): rehearsable ten-minute demonstration and honest fallback.
- [Acceptance](docs/acceptance.md): executed evidence and outstanding gates.

Implementation handoffs in `apps/api/IMPLEMENTATION.md`, `apps/web/API-INTEGRATION.md`, and `apps/collector/README.md` include older per-worker results. Source and current manifests define behavior; the latest consolidated verification is recorded in acceptance and the main-owned `BUILD_LEDGER.md`.
