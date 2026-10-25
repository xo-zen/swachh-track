# Acceptance

## Hosted-Demo Update

2026-10-25 follow-up: **29 files / 436 tests passed, zero skips**, after three migrations on a fresh disposable local PostgreSQL database. Lint, six package typechecks and production Next build with `NEXT_PUBLIC_HOSTED_DEMO=true` passed. New coverage includes hosted identity restrictions, compact/resumable seed, offline S3 signing, and supervised startup/shutdown. See [hosted-demo](hosted-demo.md) and `outputs/hosted-demo-e2e.json` for the separate compact-profile browser run. The older standard-profile snapshot below is retained as historical evidence, not the latest automated test count. No public deployment, Docker or real S3 acceptance is implied.

## Recorded Verification Snapshot

Snapshot date: **2026-10-25**. Results below record executed integration checks, [browser results](../outputs/web-e2e.json) and saved metrics benchmarks. Older implementation handoffs do not supersede the **262-test / 0-skip** result. **M8 is partial, not full acceptance or production readiness.**

| Gate                             | Latest known result                                   | What it does and does not establish                                                                            |
| -------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Toolchain/install                | Passed with Node 22 and pnpm 10.11.0                  | Root dependencies installed; use frozen lockfile for reproduction                                              |
| Prisma schema                    | Validates                                             | Schema correctness, not service readiness                                                                      |
| Migrations                       | Fresh local PostgreSQL **16.15** restored; all three migrations applied | Real migration execution; not Docker/PostGIS acceptance                                             |
| Fictional seed                   | Completed: 240 properties, 7,200 historical events    | Actual persisted synthetic fixtures/images; not civic performance                                              |
| `pnpm check`                     | Passed at **04:33 UTC**                               | Migration/seed, lint, typecheck and test gates; not browser/native acceptance                                    |
| `pnpm test`                      | **23 files, 262 tests passed; 0 skipped**              | Includes **26 real PostgreSQL integration tests**, plus unit/host tests                                         |
| `pnpm typecheck`                 | Passed all six workspace packages                     | Static types, not native/runtime correctness                                                                   |
| Root `pnpm lint`                 | Passed in the final `pnpm check`                       | Earlier missing-browser-source failure is superseded                                                           |
| Web production build             | Passed around **04:36 UTC**                            | Production-built Next was used for the final browser run; API remained development/demo                         |
| Expo compatibility               | Passes after pin updates                              | Expo 54.0.37, expo-crypto 15.0.9, expo-file-system 19.0.24; not a native build                                 |
| Local image storage              | Real Sharp image-byte integration tests passed        | Decode/normalize, metadata stripping, signed reads and ownership assertions on local storage                   |
| Redis **7.0.15** worker          | Smoke passed: **22 `DELIVERED` notifications / 22 attempt rows** | Persisted in-app delivery evidence only; retries/failures and native/external messaging not proven       |
| Web browser/E2E                  | **10/10** at **04:37:17.015 UTC**                       | Provisioned Chromium / Node Playwright; exact assertions and limits below                                      |
| PDF rendering/inspection pack    | Regression tests passed                               | Bounded pages, 4,100 rows, 3,000-ID JSON, original PDF/JPEG merge and visible decode failure; not legal completeness |
| Indexed domain metrics          | Exact baseline output preserved; **723.1 -> 92.6 ms** dashboard median | 15 runs on 7,200 events / 7,440 stops; excludes database queries, HTTP, weekly trend and Android sync    |
| Docker/Compose                   | Authored; **not runtime-tested**                      | Docker unavailable in build environment                                                                        |
| S3/MinIO                         | Implemented; **not runtime-tested**                   | Local-storage results do not prove S3 compatibility/CORS/private policy                                        |
| Android native/hardware/Maestro  | **Not run**                                           | No physical camera/GPS/airplane-mode/reboot proof                                                              |
| 500 queued-event benchmark       | **Not run**                                           | Batch limit and host queue tests are not throughput measurements                                               |
| Production integrations          | **Not configured**                                    | No SMS/FCM/WhatsApp/government delivery or malware-clean claim                                                 |
| Authored GitHub Actions workflow | Not executed here                                     | Workflow definition is not a green CI run                                                                      |

`BUILD_LEDGER.md` records the integration history; `outputs/api-validation.html` is the downloadable handoff. No public deployment was made. The private browser bridge and worker-local API/web/worker processes are temporary and do not survive task completion.

## Automated Coverage Boundaries

| Suite                                    | Evidence                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/src/*.test.ts`          | QR/tampering/rotation, verification branches, schedules, state transitions, metrics, integer-paise billing, compliance, complaint/SLA rules                                                                                                                                                                     |
| `packages/contracts/src/*.test.ts`       | Strict schema parsing and shared client behavior                                                                                                                                                                                                                                                                |
| `apps/api/tests/api.integration.test.ts` | Real PostgreSQL fixtures; HTTP and database tenant isolation; auth/device limits; real image upload/confirmation; idempotency; invalid evidence; registry/QR PDF; complaints/ratings; billing/manual payment/PDF; compliance drafts/inspection PDF; signed disabled adapters; exports and scoped read endpoints |
| `apps/api/tests/pdf.test.ts`             | Actual PDF page/text parsing: 4,100 rows, huge 3,000-ID JSON with final text preserved, original PDF pages/JPEG evidence, global page numbers and undecodable-original rejection                                                                                                                               |
| Other `apps/api/tests/*.test.ts`         | Configuration guards, route/OpenAPI/auth registration and CSV safety                                                                                                                                                                                                                                            |
| `apps/web/src/lib/*.test.ts`             | API/data helpers, route configuration and map geometry validation, not DOM/browser interaction                                                                                                                                                                                                                  |
| `apps/collector/src/model.test.ts`       | Pure capture/queue/rejection validators                                                                                                                                                                                                                                                                         |
| `apps/collector/src/storage.test.ts`     | Actual host SQLite invariants, rollback and reopen/checkpoint tests; not Expo native SQLite execution                                                                                                                                                                                                           |
| `apps/collector/src/sync.test.ts`        | Mocked transport/storage orchestration; corrected `data`/`rejectedSubmissions` verdict reconciliation, pagination, interrupted refresh and 500-row host fixture; not native upload or a 500-event throughput benchmark                                                                                          |
| `tests/web.e2e.mjs`                      | Ten real-browser scenarios, separately recorded in `outputs/web-e2e.json`; not included in the 262 Vitest tests                                                                                                                                                                                                  |

The API integration suite uses `TEST_DATABASE_URL ?? DATABASE_URL`; it skips only if neither is configured. The recorded 262-test run had a real migrated database and **did not skip** those tests. The suite creates uniquely scoped fictional tenants and retains fixtures; always use a disposable database. Do not point testing, seeding or reset at production. `apps/api/tests/api.integration.test.ts` also verifies empty-history compliance coverage is null with a scoped query reference and an empty-history annual draft.

### Metrics Evidence

The indexed stop/event calculations in `packages/domain/src/operations.ts` feed `packages/domain/src/metrics.ts`. [outputs/metrics-7200-benchmark.ts](../outputs/metrics-7200-benchmark.ts) compares every metric field, source ID/order and operation output against `outputs/metrics-7200-expected.json` using the same `outputs/metrics-7200-fixture.json`. [Before](../outputs/metrics-7200-before.json) and [after](../outputs/metrics-7200-after.json) record the same fixture hash, 7,200 events / 7,440 stops, three warmups and 15 measured runs; the after result has `baselineOutputsMatch: true`. Dashboard median decreased from **723.1 ms to 92.6 ms**. This is in-memory domain work only, not endpoint latency, database-query performance, weekly-trend timing or Android sync capacity.

## Reproduce Core Gates

After completing the README's `.env`/service setup, use a disposable PostgreSQL database with both URLs targeting the same migrated database when `TEST_DATABASE_URL` is present. Prisma migration commands use `DATABASE_URL`, not `TEST_DATABASE_URL`.

```sh
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm exec prisma validate
pnpm db:migrate
pnpm db:seed
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @swachh/collector check:expo
```

Record command, date, source revision when available, versions, exit status, test totals/skips and relevant service configuration without secrets. A green summary without its database/device/provider context is insufficient. Do not use `db:reset` or `docker compose down -v` as a generic recovery action against valued data.

## CI Contract

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) provisions plain PostgreSQL 16 and Redis 7, installs Node 22/pnpm 10.11.0 with the frozen lockfile, generates fresh random test-only JWT/QR secrets, validates/generates Prisma, migrates and seeds synthetic fixtures with `NODE_ENV=development` and `DEMO_MODE=true`, then runs lint, all-package typecheck, tests, Expo compatibility and the web build.

Plain PostgreSQL is intentional: current migrations use SQL/PLpgSQL but do not install or query PostGIS. The Compose image has PostGIS available; this CI job makes no spatial-extension claim. The test database password is explicitly disposable CI configuration, not a deployment secret. JWT and QR keys are generated independently per run. CI local storage is disposable too.

This core job **does not run browser E2E, the notification worker, Android/Maestro or MinIO**. Redis being provisioned does not establish worker acceptance. No `continue-on-error` hides lint/tests/build failures. Browser acceptance requires an actual browser run, not the `pnpm e2e` script name appearing in a manifest.

## Runtime Evidence And Remaining Gates

### Browser

Root `package.json` declares `pnpm e2e` as `node scripts/e2e.mjs`, which imports **`tests/web.e2e.mjs`**, not a `.ts` file. The final run used provisioned Chromium and Node Playwright with the private request bridge in `.bcode/agent-workspace/hosted-e2e.mjs`, against production-built Next on worker-local port 3000 and a development/demo API on port 4000. The browser-facing `https://swachh-track.test` is a bridged test origin, not a public deployment. A fresh, separate disposable database, **`swachh_browser_acceptance`**, avoided OTP-limit exhaustion caused by repeated development tests; no user data was reset and no OTP security limit was weakened.

The runner uses `E2E_CDP_URL` for `chromium.connectOverCDP`; without it, local headless launch is allowed only outside the hosted cloud environment (the runner rejects `BU_CDP_WS` without an explicit CDP URL). `E2E_REUSE_PAGE=true` selects the first existing context and its `swachh-track.test` page, or first page; otherwise it creates and closes a new context. `E2E_BASE_URL` defaults to `http://localhost:3000`. These variables alone do not bridge remote-browser traffic to worker localhost. In cloud runs, all browser interactions go through **`browser_execute`** using the provisioned browser and the hosted helper, never a local browser launch. See [tests/README.md](../tests/README.md) for external-machine Playwright setup.

The final [outputs/web-e2e.json](../outputs/web-e2e.json) was generated at **2026-10-25T04:37:17.015Z**, with **10/10 PASS** and `nativeAndroidTested: false`. Durations are per-scenario measurements, not service latency benchmarks. Assertions are in [tests/web.e2e.mjs](../tests/web.e2e.mjs):

| Scenario | Duration (ms) | Asserted scope / boundary |
| --- | ---: | --- |
| Society OTP login/dashboard | 1,666 | Development/demo OTP login and server-calculated dashboard labels |
| Responsive dashboard/Hindi | 310 | No horizontal overflow at 360/390/768/1280 widths; Hindi language switch, not every screen at every width |
| Property import/QR | 1,829 | 20 persisted imported properties and actual QR PDF bytes |
| Invoice | 783 | Draft generation or existing-draft handling, integer-paise total, positive deductions and PDF bytes; no UI issue/payment action |
| Annual draft/inspection pack | 13,640 | Draft generation or existing-draft handling and actual annual/inspection PDF downloads; legal completeness not asserted |
| Resident evidence | 858 | Verified pickup evidence and loaded private image; rating submission only if the rating control exists |
| Complaint | 1,008 | UI image upload/creation; status changes, resolution photo and reopen via authenticated browser `fetch`; reopened complaint visible in UI |
| Supervisor | 810 | Login, review queue, evidence dialog and visible Approve/Reject controls; **no approval/rejection click** |
| ULB | 14,155 | Login, visible map canvas, contractor filter, SLA filter and actual CSV bytes; not geographic accuracy or realtime tracking |
| Collector | 381 | Login and Android-app handoff message; no native capture/sync |

All five primary roles logged in. Saved downloads are `outputs/example-qr-stickers.pdf`, `outputs/example-invoice.pdf`, `outputs/example-annual-return-draft.pdf`, `outputs/example-inspection-pack.pdf` and `outputs/example-complaints.csv`; screenshots are `outputs/swachh-track-desktop.png` and `outputs/swachh-track-mobile.png`. PDF merge/content correctness has separate tests in `apps/api/tests/pdf.test.ts`; the browser suite checks successful download bytes, not every embedded page.

Remaining broad browser acceptance includes membership switching/isolation in the UI, disconnected API/error and empty states, token refresh, route forms, actual supervisor decisions, unconditional rating coverage, UI complaint resolution/reopen, invoice issue/payment and wider responsive coverage. The ten scenarios do **not** establish those gates or full workflow acceptance.

### Worker And Storage

- The main-run smoke of `apps/api/src/worker.ts` against Redis **7.0.15** persisted **22 `DELIVERED` notifications and 22 `NotificationAttempt` rows**. This is a simple in-app delivery smoke, not just log text or outbox creation. Repeated scan/delivery, retries/failures, opt-out, IST quiet hours, SLA escalation and authenticated inbox presentation still need explicit runtime acceptance; native/external delivery is not proven and production SMS/WhatsApp/FCM are absent.
- Run Compose from a fresh disposable volume set elsewhere. Verify migrate/seed service completion, API/web readiness, worker startup, restart persistence and private MinIO byte transport. Record exact image/platform versions; this gate is presently unexecuted.
- For S3/MinIO, test browser/phone presign PUT, expired URL renewal, confirmation, independent normalized key, private GET, tampering/expiry, ownership and bucket CORS/policy. Confirm originals and normalized data survive intended restarts. Local-image tests cannot substitute.

### Android And Offline

Use the actual app/device and `apps/collector/.maestro/` flows after configuring today's real test-site properties/routes, reachable API/storage origins and printed signed QRs. These flows are authored acceptance aids, not executed proof. The package-local README explains flow variables; native app ID is `in.swachhtrack.collector`.

1. Capture three offline pickups with real photos, weights and fresh foreground GPS; force-stop and reboot, then verify saved drafts/events/files remain. Never clear app data/uninstall while evidence is pending.
2. Reconnect and interrupt after presign, PUT, confirmation and server batch commit. Retry with the same UUID/key/payload; prove one server event, durable rejections and no reupload of confirmed images.
3. Verify offline results are `NEEDS_REVIEW`, then approve valid weighed evidence with a reason before resident rating/billing. Hard-rejected events must remain rejected; approved exceptions must not create verified kg.
4. Exercise denied permissions, inaccurate/stale GPS, wrong property/QR, expired route, missing/zero weight, duplicate photo, contamination without explanation, revoked device, disk exhaustion, sign-out/re-login and membership isolation.
5. Measure a 500-queued-event run on a named low-end Android device/network: evidence volume, queue persistence, wall time, peak memory, disk growth, failed/retried events and duplicate counts. No throughput target is accepted until measured.

The earlier collector status-envelope mismatch is **fixed**: `refreshVerdicts` in `apps/collector/src/sync.ts` reads paginated `data` plus `rejectedSubmissions`. `apps/collector/src/sync.test.ts` covers reviewed verdicts, rejected submissions, interrupted refresh, invalid pagination and 500 rows. These host tests do not replace native reconciliation, restart or 500-event upload/performance acceptance.

## Release Decision

The current result supports a **synthetic pilot/backend demonstration with scoped browser evidence**. **M8 remains partial**, not production, broad full acceptance or completed field-pilot acceptance. The ten-minute script is in [demo-script](demo-script.md).

Known product boundaries are not hidden test passes: vehicle management is omitted; registration data/editing exists; inspection PDF merges available stored PDF/JPEG originals and generated invoice PDFs, fails on undecodable evidence rather than silently returning a partial pack, and keeps missing references explicit; maps are not realtime tracking and seed boundaries are fictional; providers/FCM/scanning are unconfigured; privacy requests are review-only; no destructive retention executor or verified legal claim exists. Billing/compliance are explicit demo flags, not universal production enablement.

Release requires the pending runtime gates plus production authentication, provider/storage/security hardening, reviewed legal/privacy obligations, restore/incident procedures and measured capacity. A green core CI run cannot waive them.
