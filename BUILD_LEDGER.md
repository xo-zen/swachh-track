# Build Ledger

## Environment and scope

Initial inspection: empty application workspace; no Git repository. Node v22.23.2 on Linux arm64. `npm`, `pnpm`, `docker`, `psql`, and `redis-server` not on PATH. Downloaded pinned pnpm 10.11.0 into /tmp/bcode; `node /tmp/bcode/package/bin/pnpm.cjs --version` returned `10.11.0`.

| Milestone | Status | Acceptance gate |
| --- | --- | --- |
| M0 Foundation | Implemented; database gates pass | auth, tenant isolation, three migrations, repeat-safe seed, health |
| M1 Registry | Implemented; integration gates pass | properties, 20-row import, signed QR PDF, schedules and dated routes |
| M2 Capture | Implemented; native acceptance outstanding | Expo SDK check and 77 collector tests pass; no physical Android run |
| M3 Verification | Implemented; integration gates pass | actual image bytes, normalized hashes, rejection persistence, idempotency, review |
| M4 Resident/complaints | Implemented; integration gates pass | verified ratings, resolution evidence, SLA/reopen and transactional outbox |
| M5 Billing | Implemented; integration gates pass | integer-paise lines, evidence links, PDF, issue/payment/dispute |
| M6 Compliance | Implemented; integration gates pass | eligibility, certificates, handovers, annual JSON/PDF and merged inspection PDF |
| M7 ULB | Implemented; integration gates pass | scoped dashboard, CSV/XLSX/PDF, read isolation and audit |
| M8 Hardening | Partial; browser smoke and core gates pass | 10 browser scenarios, packaging and measured limitations; native/deployment acceptance remains open |

## Open risks

- Docker is not installed in the execution environment. Docker Compose acceptance must not be claimed until actually executed.
- No physical Android device is available. Camera, GPS, airplane-mode/restart and 500-stop performance require separate measured validation.
- Production OTP, FCM and messaging credentials are absent; adapters must fail explicitly rather than report delivery.
- The requested scope is a multi-week pilot build. Implementation coverage and measured checks will be reported separately from the full definition of done.

## Executed gates, 25 October 2026

Independent domain, API, web and collector implementation proceeded in parallel. The requested strictly sequential per-milestone gates were **not** executed at each initial source handoff: dependencies and database provisioning were initially unavailable. These are consolidated post-integration results, not retroactive claims of those gates.

| Command / check | Actual result |
| --- | --- |
| `pnpm install` (pinned 10.11.0) | Installed workspace dependencies; generated committed lockfile. Temporary dependency store outside the 1 GiB workspace. |
| `pnpm exec prisma validate` | Schema valid. |
| `pnpm db:generate` | Prisma Client 6.8.2 generated. |
| `pnpm db:migrate` | All three migrations applied successfully to PostgreSQL 16.14. Later runs: no pending migrations. |
| `pnpm db:seed` | Created fictional tenant, 240 properties, 7,200 historical scenarios, demo users, actual synthetic images and isolation tenant. Repeat run skipped without overwriting. |
| `pnpm lint` | Initially failed on missing test directory, then generated Next declaration and E2E lint errors. Fixed. Final consolidated gate passed. |
| `pnpm typecheck` | All six packages pass after fixing map geometry and API constructor/UUID inference types. |
| `pnpm test` | **22 files, 251 tests passed, zero skipped** at 02:16 UTC. Includes 24 real-PostgreSQL HTTP integration tests, 77 collector tests and actual PDF composition checks. |
| `pnpm --filter @swachh/collector check:expo` | Passed after pinning Expo 54.0.37, crypto 15.0.9 and file-system 19.0.24. |
| `pnpm --filter @swachh/web build` | Passed during web integration; final post-hardening build still pending. |
| `pnpm check` | Complete migration -> repeat seed -> lint -> typecheck -> tests pipeline passed at 02:16 UTC. |
| API `/api/v1/healthz`, `/api/v1/readyz` | HTTP 200; PostgreSQL ready. |
| `pnpm --filter @swachh/api worker` | Running against Redis 7.0.15. Database inspection confirms DELIVERED in-app outbox records, including SLA breach and certificate reminders. |
| First `pnpm e2e` | Real-browser login and all four responsive widths/Hindi passed. Twenty-property import and real 106,972-byte browser QR download worked; test runner incorrectly read the intercepted PDF response as empty. Test capture corrected to inspect the actual downloaded Blob; rerun pending. |

## Defects found and fixed during integration

- Fastify's default URL parameter length rejected signed upload capabilities with 404. Raised the bounded parameter limit to 2,048; real image-upload and downstream workflows now pass.
- Collector verdict refresh expected `results`, while API pagination returns `data`. Fixed paginated reconciliation and supervisor-verdict refresh with regression tests.
- A photo uploaded before restart could expire before confirmation and be treated as a permanent rejection. Explicit expiry now re-reserves and reuploads retained local bytes, with retry/checkpoint tests.
- Inspection pack originally contained only document references. It now appends actual stored PDF/image originals and detailed invoices, with global page numbering and IST generated-at timestamps; invalid originals produce a visible failure, not a partial-success PDF.
- Internal S3 operations and client presigning now support separate internal/public endpoints for Compose networking.

## Remaining acceptance risks

- No Docker daemon: Compose image build/start and PostGIS extension runtime are not measured here.
- No Android device/emulator: camera, GPS, airplane mode, Maestro and native restart still require validation. Host SQLite/retry tests are not hardware tests.
- No measured 500-stop under-10-second sync. The collector currently persists and sends events one at a time; a 500-verdict pagination test is not a throughput benchmark.
- S3/MinIO integration not yet executed; local private signed-byte transport is tested. Standalone MinIO binary archive download returned HTTP 410.
- Production SMS, WhatsApp, FCM and malware scanning remain explicitly NOT_CONFIGURED. The requested pilot cannot accept real phone sign-in until an OTP provider is supplied and implemented.

## Resumed hardening, 25 October 2026

The saved browser result at 02:18 UTC was newer than the earlier ledger: four scenarios passed, then the annual/inspection PDF scenario failed with HTTP 500. The worker-local dependency, database and storage state had expired. Restored dependencies with the frozen pnpm 10.11.0 lockfile and fresh disposable PostgreSQL 16.15 / Redis 7.0.15; no existing user data was reset. The optional `msgpackr-extract` native build failed without a compiler on arm64, but install completed and the actual Redis worker ran successfully.

### Confirmed fixes

- Reproduced the PDF renderer failure with 4,000 evidence rows: PDFKit rejected an unsupported numeric coordinate after oversized automatic pagination. Bounded explicit pages and text blocks now retain all evidence. Regression tests decode actual PDF page streams for 4,100 rows, a 3,000-ID JSON line and a 5,000-character word; original PDF/JPEG content and final evidence remain present.
- Empty-history compliance used an empty provenance list and threw instead of rendering. It now includes a tenant/society/period-scoped query reference, returns null coverage and can generate a draft. The database integration suite covers this case.
- Indexed event/stop lookups remove repeated full scans while preserving validation order and exact metric/provenance output. Filtered contractor dashboards reuse identical request-local totals.
- Repaired browser acceptance assertions: real OTP form login works with production-built web, existing annual drafts can be reused, filters use accessible combobox names, complaint textarea is not confused with page metadata, quoted CSV headers are recognized, and asynchronous contractor results are awaited. No production security limits were weakened.

### Executed final gates

| Gate | Actual result |
| --- | --- |
| `pnpm check` | Passed at 04:33 UTC: migrations, repeat-safe seed, lint, all six package typechecks and **23 files / 262 tests / zero skipped**, including **26 real PostgreSQL integration tests**. |
| `pnpm build` | Final production Next build passed; compile, types, static generation and tracing completed. |
| `pnpm --filter @swachh/collector check:expo` | Passed; no native binary or device acceptance implied. |
| Browser acceptance | **10/10 PASS at 04:37:17 UTC**. Provisioned Chromium via Node Playwright, production-built Next and development/demo API. Actual local private-byte uploads and PDF/CSV downloads. See `outputs/web-e2e.json` and `docs/acceptance.md` for exact assertions. |
| Browser fixtures | Fresh separate `swachh_browser_acceptance` database, three migrations and 240-property / 7,200-event seed. Earlier repeated debug runs reached OTP cooldown/IP limits; final clean fixture run exercised all five roles without bypassing those limits. |
| Worker smoke | Redis-backed worker persisted 22 DELIVERED notifications and 22 attempt rows in the core test database. Retry/failure handling and authenticated inbox presentation are not established by this smoke. |
| Metrics benchmark | Same frozen 7,200-event / 7,440-stop fixture, 3 warmups and 15 measurements. Dashboard median **723.1 -> 92.6 ms**, verified stops **523.9 -> 36.6 ms**, billable missed stops **613.3 -> 38.1 ms**. Exact outputs match. Domain-only measurements exclude HTTP, database queries, weekly trend and Android sync. |

The annual/inspection browser scenario took 13.64 seconds; the multi-action ULB scenario took 14.16 seconds. These are functional passes, not capacity or endpoint latency targets. Browser smoke does not cover every screen, UI membership switching, offline error states, UI invoice settlement or actual supervisor approval clicks; corresponding API tests do not replace UI/native acceptance.

Final handoff: updated setup/acceptance/compliance docs, `outputs/api-validation.html`, actual sample PDFs/CSV, screenshots, test results and a source archive excluding secrets and generated dependency/build directories. No public deployment was made. Worker-local services and the private browser bridge stop after the task; source and downloadable artifacts persist. M8 and the full field-pilot definition of done remain partial until the native, infrastructure and production-provider gates above are completed.

## Limited Hosted Demo, 25 October 2026

- Implemented hosted identity restrictions and compact seed: five primary societies, 30 properties, seven historical days / 210 pickups, 408 photo objects. Standard 240-property seed remains unchanged. Dedicated integration tests cover incompatible/resumable seeds and unchanged fixture identities/memberships.
- Added production-built hosted UI shortcuts and English/Hindi notices; hidden identity mutations. Production backend demo-mode guards remain unchanged. Added S3 `WHEN_REQUIRED` request-checksum behavior with offline signed-URL regression tests.
- Added `Dockerfile.render`, one-service `render.yaml` with `plan: free`, supervised launcher, loopback API binding and S3 check-only preflight. No worker, Redis, disk, paid pre-deploy hook or database reset. Startup/child-failure/shutdown tested with real local child processes; S3 preflight tested with mocks.
- Fresh disposable PostgreSQL full run: **29 files / 436 tests / zero skips**, all three migrations, root lint and all six package typechecks passed. Verification helper removed only its own database; existing `swachh` remained intact. Production Next build with hosted presentation flag passed.
- Compact browser run passed **11/11** using production Next, guarded development API, fresh disposable local PostgreSQL and local private-byte storage via provisioned Chromium/private bridge. Results and screenshots: `outputs/hosted-demo-e2e.json`, `hosted-demo-login.png`, `hosted-demo-desktop.png`, `hosted-demo-mobile.png`. Responsive screenshots wait for stable sidebar bounds. Not a public URL or S3 result. Standard 10-scenario evidence remains separate.
- Render API successfully listed `My Workspace` and no services. Supabase API listed `Swacttrack` (four existing public tables) and `Swact` (no public tables). Provider resources/data were not changed. Supabase project choice and source-repository upload approval remain unresolved; account free-plan allowance must still be checked.
- Docker is still absent. Actual image build, Render resource-limit/cold-start tests, managed PostgreSQL/private S3/CORS acceptance and native gates remain open. CI now declares the disposable seed-admin URL but no GitHub Actions run is claimed.
