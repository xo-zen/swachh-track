# Acceptance tests

## No-login results

2026-10-25: **30 test files / 582 tests passed / one mode-specific skip**, using disposable local PostgreSQL 15.19. Lint, all six package typechecks, production web build and Expo compatibility passed. `tests/no-auth.e2e.mjs` passed ten scripted checks in the provisioned browser; a separate startup outage/retry check passed without revealing login. See [no-login verification](../docs/no-login.md) for boundaries. Physical Android and public deployment were not tested.

## Earlier recorded results

On **2026-10-25**, `pnpm check` passed at **04:33 UTC**: lint, all six package typechecks and **23 files / 262 tests / 0 skips**, including **26 real PostgreSQL integration tests**. Fresh local PostgreSQL **16.15** was restored, all three migrations applied, and fictional fixtures seeded with 240 properties / 7,200 historical events. The web production build passed around **04:36 UTC**; Expo compatibility passed. This documentation update did not rerun those commands.

Unit and PostgreSQL integration tests live beside their modules and run with `pnpm test`. `apps/api/tests/api.integration.test.ts` uses `TEST_DATABASE_URL ?? DATABASE_URL` and skips without either. Use a disposable migrated database; `pnpm check` migrates and seeds via `DATABASE_URL`, so align both URLs when set. Never reset valued or user data to reproduce acceptance.

## Browser suite and runner

The suite is **`tests/web.e2e.mjs`**, not `.ts`. `pnpm e2e` invokes `node scripts/e2e.mjs`. It needs a running seeded API/web with server `NO_AUTH=false`, reachable signed storage URLs and a real Chromium browser. Runner configuration in [scripts/e2e.mjs](../scripts/e2e.mjs):

| Variable | Actual behavior |
| --- | --- |
| `E2E_CDP_URL` | Connects to an existing browser with `chromium.connectOverCDP`; otherwise launches local headless Chromium. If `BU_CDP_WS` is set without this variable, the runner throws instead of launching locally. |
| `E2E_REUSE_PAGE` | Only the exact value `true` reuses the first browser context and its `swachh-track.test` page, falling back to its first page. Otherwise creates a context/page and closes that context afterward. |
| `E2E_BASE_URL` | App origin; defaults to `http://localhost:3000`. This alone does not make worker-local services reachable from a remote browser. |

On an **ordinary external development machine**, with disposable seeded services already running:

```sh
pnpm exec playwright install --with-deps chromium
pnpm e2e
```

That installation/local-launch path is **not for hosted cloud workers**. In cloud runs, use **`browser_execute` for all browser interactions**, the already provisioned Chromium, and `.bcode/agent-workspace/hosted-e2e.mjs`. Its `setup()` connects Node Playwright to `BU_CDP_WS`, reuses the existing page and privately bridges `swachh-track.test` to worker-local Next on port 3000 and `localhost:4000` to the API. Invoke the helper and `runWebAcceptance(page, 'https://swachh-track.test')` from `browser_execute`; do not launch/install a local cloud browser or treat the private origin as a deployment.

The final run used **production-built Next with a development/demo API**, not production authentication/providers, and a fresh separate disposable database, **`swachh_browser_acceptance`**, to avoid OTP-limit exhaustion from repeated development tests. This did not reset user data or disable security limits. Worker-local processes and the private bridge do not survive task completion; there is **no public deployment**.

## Access modes

The default demo setup now uses `NO_AUTH=true` with `NODE_ENV=development` and `DEMO_MODE=true`. Clients discover the mode from `/api/v1/access`; no frontend mode flags are needed. Existing login suites **`tests/web.e2e.mjs` and `tests/hosted-demo.e2e.mjs` require the API to run with `NO_AUTH=false`**, retaining development/demo mode for fixed OTP. Set that server environment and restart before running either suite; setting it only on the test runner does not change a running API.

`tests/no-auth.e2e.mjs` exports `runNoAuthChecks(session, appOrigin)` for an attached CDP session. Invoke it from `browser_execute` with the provisioned browser and a reachable, disposable, seeded open-demo app. It does not launch a browser or provision services. It checks direct entry, all five roles, reload, locked identity controls, phone-width navigation and Hindi. See [no-login verification](../docs/no-login.md) for this change's results and limits. Historical results below and in [hosted-demo checks](../docs/hosted-demo.md#executed-checks) remain authenticated-mode evidence, not native Android or production acceptance.

## Browser evidence and limits

[outputs/web-e2e.json](../outputs/web-e2e.json) records **10/10 PASS** at **2026-10-25T04:37:17.015Z** with per-scenario durations and `nativeAndroidTested: false`. These scenarios are separate from the 262 Vitest tests. See [acceptance](../docs/acceptance.md#browser) for the exact duration table.

- Demo OTP login for all five roles; dashboard overflow checks at 360/390/768/1280 widths and a Hindi language switch, not all screens at all widths.
- Import 20 persisted properties and download actual QR/invoice PDFs; invoice generation/existing-draft handling and deductions, not UI issue/payment.
- Annual-draft generation/existing-draft handling and actual annual/inspection PDF downloads; browser checks PDF bytes, not every embedded page or legal completeness.
- Resident verified evidence and a loaded private photo; rating submission is conditional on the control being present.
- Complaint image upload and creation through UI; status changes, resolution photo and reopen through authenticated browser `fetch`, with reopened state checked in UI.
- Supervisor review/evidence controls visible, **without clicking Approve or Reject**; ULB map canvas, contractor/SLA filters and CSV download; collector web-to-Android handoff only.

Screenshots and downloaded samples are in `outputs/swachh-track-desktop.png`, `outputs/swachh-track-mobile.png`, `outputs/example-qr-stickers.pdf`, `outputs/example-invoice.pdf`, `outputs/example-annual-return-draft.pdf`, `outputs/example-inspection-pack.pdf` and `outputs/example-complaints.csv`. Do not infer full UI acceptance, offline capture, provider delivery or native Android behavior from these ten scenarios.

## Regression and runtime boundaries

- `apps/api/tests/pdf.test.ts` tests bounded pages with 4,100 rows and huge 3,000-ID JSON while preserving final text; original PDF/JPEG merge, page numbers and visible failure on undecodable originals. `apps/api/src/compliance.ts` also adds generated invoice PDFs to the inspection pack; it is not a references-only export.
- `apps/api/tests/api.integration.test.ts` tests empty-history null coverage with a scoped query reference and annual draft. `apps/collector/src/sync.test.ts` covers the fixed `data`/`rejectedSubmissions` reconciliation in `apps/collector/src/sync.ts`; its 500-row host fixture is not a device sync benchmark.
- `outputs/metrics-7200-benchmark.ts`, `outputs/metrics-7200-before.json` and `outputs/metrics-7200-after.json` establish exact baseline-equivalent domain output on 7,200 events / 7,440 stops. Over 15 measured runs after three warmups, dashboard median fell **723.1 -> 92.6 ms**. This excludes database queries, HTTP endpoints, weekly trend and Android sync.
- The reported Redis **7.0.15** worker smoke persisted **22 `DELIVERED` notifications / 22 attempt rows** via `apps/api/src/worker.ts`. Retry/failure behavior and native/external messaging remain unproven; production SMS/WhatsApp/FCM and malware scanning are absent.
- Docker was unavailable; Compose and S3/MinIO were not runtime-tested. Physical Android/Maestro and 500-event sync performance were not run. Authored flows in `apps/collector/.maestro/` require a configured device/emulator and do not themselves prove execution.

**M8 remains partial, not production or broad full acceptance.** Never interpret an absent database/device as a passing integration test. [docs/acceptance.md](../docs/acceptance.md) records remaining gates; `BUILD_LEDGER.md` and the outputs status page remain main-owned.
