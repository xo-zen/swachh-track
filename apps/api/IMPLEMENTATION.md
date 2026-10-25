# API Implementation

Status: implementation and six missing web read endpoints delivered. API typecheck, API/Prisma lint, and 20 database-independent tests pass. All 24 PostgreSQL integration tests are skipped because neither database URL is configured. Database-backed behavior is not yet a passing acceptance gate.

## Runtime

- Dependencies are installed and the Prisma client is generated. Node 22, exact pinned versions as requested.
- Entrypoints: `src/server.ts`, `src/worker.ts`; test factory: `buildApp` from `src/app.ts`.
- Root owner retains database provisioning, migrations and seed execution. This follow-up did not run installation, generation, migrations or seeds.
- Required: `DATABASE_URL`, `JWT_SECRET` and `QR_SECRET` (at least 32 characters each).
- Demo requires **both** `NODE_ENV=development` and `DEMO_MODE=true`; phone OTP `123456`. Production rejects demo mode. Non-demo OTP returns 503 until an SMS provider is configured, never fake success.
- Explicit local storage: `STORAGE_DRIVER=local`, `API_PUBLIC_URL=http://localhost:4000`, optional `LOCAL_STORAGE_PATH=apps/api/.storage`. Production requires S3. Default driver is S3.
- Additional configuration: `QR_SECRET_VERSION`, `CORS_ORIGINS`, `PORT`, S3 variables, `REDIS_URL`, optional `SWACHHATA_WEBHOOK_SECRET` and `WHATSAPP_WEBHOOK_SECRET`.
- The API resolves the root `.env` and relative local-storage paths from the project root, including when launched with `pnpm --filter @swachh/api dev`.

## Stable Contracts

All business endpoints use `/api/v1`. OpenAPI UI uses `/docs`. Strict request bodies reject unknown fields. List responses use `{data,nextCursor}`; default 25 and max 100.

- OTP request `{phone}`; verify `{phone,code}`. Demo email aliases accepted as the phone field only in development/demo. Auth response `{accessToken,refreshToken,user,memberships}`. `/me` adds `activeMembership`. Select with `X-Membership-Id`.
- Collector routes and pickup/photo requests follow the exact task contracts. Batch events are individually validated inside the transaction so rejected UUIDs persist. Hard rejected batches return HTTP 422 with `{results}`. Identical idempotency replay returns original status and response. Duplicate UUID on a different batch returns 409 with original accessible results.
- Device request `{deviceId,platform,appVersion}`. Maximum two bound devices.
- General web uploads: `POST /files/presign` with `{filename,contentType,size,purpose}`. Purpose: `COMPLAINT|RESOLUTION|COMPLIANCE|DOCUMENT|PROCESSING|HANDOVER`; content types JPEG, PNG, WEBP, PDF, <=8 MiB. PUT actual bytes, then `POST /files/:id/confirm {}`. Use the returned `fileId` as complaint/resolution `photoId` for images. PDF is document-only. Collector photo routes stay camera-only JPEG.
- Compliance document body follows shared `documentSchema`: `{type,number,issuedBy,issuedAt,validUntil?,storageKey}`. `storageKey` must be an owned confirmed upload ID or its returned storage key, not an arbitrary path. Dates are `YYYY-MM-DD`.
- Vendor body `{name,type,authorizationNumber,validUntil,documentId,contractorId?}`. `validUntil` is an ISO datetime. `type`: `COLLECTOR|TRANSPORTER|MRF|RECYCLER|COMPOST|BIOGAS`.
- Schedule body follows shared `scheduleSchema` with nested `pattern` (`WEEKLY` weekdays / `EVERY_N_DAYS` everyNDays).
- Route creation: `POST /societies/:societyId/routes {name,date,collectorId,vendorId,propertyIds}`. Derives windows and streams from schedules; requires documented, unexpired vendor and contractor.
- Invoice generation body follows shared `invoiceGenerateSchema`, with `Idempotency-Key`. Generates a **DRAFT**; explicitly `POST /societies/:societyId/invoices/:id/issue {}` before manual payment. Payment body `{amountPaise,paidAt,reference}`.
- Complaint transitions: `PATCH /complaints/:id {status,note?,photoId?}` (or society-scoped path). Enforces OPEN -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED, with documented waiting/reopen branches. Resolution requires a confirmed RESOLUTION image.
- Certificates can only be recorded by ULB_ADMIN/SUPER_ADMIN. ULB body `{societyId,certificateNo,stream,kg,issuedAt,validUntil?,documentId}`. Society path omits societyId. No certificate issuance or CPCB submission is claimed.
- Handover body follows shared `handoverSchema`: `{date,vendorId,stream,kg,receiptNumber,documentId,destination}`.
- Onsite paths `/societies/:societyId/compliance/onsite-logs`; body `{asset,capacityKg,date,inputKg,outputKg,downtime?,photoId}`.
- Annual return body `{financialYearStart}` with `Idempotency-Key`; JSON at `/annual-return/:id`, PDF at `/annual-return/:id.pdf`. Inspection pack at `/compliance/inspection-pack.pdf`.

### Web Read Endpoints

All paths below are prefixed with `/api/v1`. Tenant access always comes from the authenticated membership, not optional query filters. Conflicting society/ward filters return no records; foreign, out-of-society or out-of-filter cursors return 404 rather than shifting pagination across scope boundaries.

| GET path | Access and response |
| --- | --- |
| `/societies/:societyId/pickups` | Society/ULB/super admin; scoped `{data,nextCursor}` with streams. |
| `/ulb/:ulbId/pickups` | ULB/super admin; selected-tenant `{data,nextCursor}` with streams. |
| `/pickups/:id` | Society/ULB/super admin; scoped event, public property fields, streams and confirmed photo metadata with five-minute signed URLs. Private/no-store. Supervisor detail reuses this implementation. |
| `/societies/:societyId/compliance/annual-returns` | Society/ULB/super admin and `compliance_v2`; paginated draft metadata, without snapshot payload. |
| `/societies/:societyId/invoices/export.csv` | Society/ULB/super admin and `billing_v1`; audited private/no-store accounts CSV, including invoices and their payments. Rejects over 10,000 combined records. |
| `/resident/properties` | Resident only; active resident links within the selected membership's society. Paginated public property fields and society `{id,name,wardId}`; no QR credentials or resident records. |

- Pickup lists accept `cursor`, `limit`, `societyId`, `wardId`, ISO-offset `from/to` on capture time, and a validated pickup `status`.
- Annual-return lists additionally accept `financialYearStart`; `from/to` filter generation time and the supported status is `DRAFT`.
- Resident properties support unit/block `search`, `ACTIVE|INACTIVE` property status, creation-time `from/to`, society/ward filters and scoped pagination. Inactive resident links are always excluded.
- Society accounts exports accept invoice `status`, `from/to` on invoice period start and society/ward filters. Payments belong to the selected invoices; payment dates are not independently filtered. Columns: `recordType,id,invoiceId,societyId,date,status,amountPaise,reference`.
- CSV escaping/formula neutralization and invoice/payment row mapping are shared with ULB exports. Empty exports retain headers.

## Files and Ownership

- `src/app.ts`: exported `buildApp({db?,config?,logger?})`, Fastify plugins, error envelope, Zod OpenAPI and route registration.
- `src/core.ts`: authentication/membership guard, role policy, tenant/property/contractor scope predicates, transactions, audit, notification outbox and pagination helpers.
- `src/config.ts`, `src/auth.ts`: explicit deployment configuration, hashed OTP attempts/cooldown/five requests per phone-hour, JWT, refresh-family rotation/reuse, profile and privacy requests.
- `src/registry.ts`: validated property/CSV mutations, QR token rotation and PDF sheet, invitations/deactivation, nested-pattern schedules, vendors, settings and dated route creation.
- `src/storage.ts`: private S3 capabilities, explicit local signed byte transport, reserved uploads, image normalization, confirmed-image ownership checks and private read capabilities.
- `src/pickups.ts`: assigned routes, bound devices/revocation, strict durable per-event validation, idempotent sync, evidence claims, duplicate hash checks, supervisor evidence/review and stop reassignment.
- `src/operations.ts`: resident schedule/history/evidence/ratings, categories, complaint transitions, pause-adjusted SLA, once-only reopen/escalation, local and Swachhata outbound channels, notification inbox.
- `src/analytics.ts`: database-to-domain operational data mapping. Business formula implementations remain in `@swachh/domain`.
- `src/billing.ts`: auditable integer-paise monthly drafts, issue, immutable evidence lines, PDF, manual partial/full payments, dispute tasks and transactional notifications.
- `src/compliance.ts`: eligibility, registration, document vault, external ULB certificate ledger, authorization-checked handovers, ULB handover verification, self-reported onsite logs, monthly log, annual JSON/PDF snapshot and inspection PDF.
- `src/reporting.ts`: society/contractor/ULB dashboards, ward/society registry, collectors/routes, complaint queue, audit, flags/settings/categories, CSV/XLSX/PDF/accounts exports and signed disabled webhooks.
- `src/pdf.ts`: actual server-side React PDF documents, page numbers, timestamps and QR images.
- `src/worker.ts`: exported outbox/reminder routines and BullMQ worker entrypoint, job deduplication, retries, delivery-attempt rows, opt-ins, IST quiet hours, schedule/certificate reminders and two-stage SLA escalation.
- `src/seed-data.ts` and `prisma/seed.ts`: repeat-safe fictional fixture creation; completed seed is recognized by its append-only audit marker, not by partial row counts.
- `src/csv.ts`: shared CSV escaping, date/null handling and spreadsheet formula neutralization.
- `tests/api.integration.test.ts`: 24 real-PostgreSQL integration tests with isolated fixture tenants and real uploaded image bytes.
- `tests/config.test.ts`: two deployment-security configuration tests.
- `tests/routes.test.ts`: seven database-independent endpoint registration, authentication and OpenAPI checks.
- `tests/csv.test.ts`: 11 database-independent CSV encoding and formula-safety checks.
- `prisma/schema.prisma`, `prisma/migrations/202610250001_initial/migration.sql`, `202610250002_guardrails/migration.sql`, `202610250003_tenant_constraints/migration.sql`, `migration_lock.toml`.

No root manifest, README, Docker file, ledger, decisions, domain/contracts source, web or collector source was edited by this agent.

## Persisted Models

43 models: `Ulb`, `Ward`, `Society`, `Property`, `User`, `Membership`, `Resident`, `OtpChallenge`, `RefreshToken`, `Contractor`, `Collector`, `Vehicle`, `Vendor`, `Schedule`, `Route`, `RouteStop`, `Device`, `PickupEvent`, `PickupStream`, `Photo`, `Upload`, `PickupException`, `IdempotencyKey`, `RejectedSubmission`, `ComplaintCategory`, `Complaint`, `ComplaintEvent`, `Rating`, `Invoice`, `InvoiceLine`, `Payment`, `InvoiceDispute`, `ComplianceDocument`, `EbwgrCertificate`, `Handover`, `OnsiteLog`, `AnnualReturn`, `MassBalance`, `AuditLog`, `Notification`, `NotificationAttempt`, `OutboundMessage`, `PrivacyRequest`.

All operational records carry `ulbId`; global identity challenges/refresh tokens are user-scoped. PostgreSQL adds deferred same-tenant reference constraints, positive kg/money/score/date checks, one verified weighed pickup per stop, and append-only audit/complaint-history triggers. UUIDs are generated by Prisma. Operational amounts use integer paise and `numeric(10,3)` kg. Complaint SLA hours are snapshotted at creation, so editing a category does not silently rewrite an existing complaint's SLA.

The seed creates Nagar Municipal Corporation, two wards, the five requested named societies, 240 properties, six collectors, two contractors, three daily route templates (93 dated instances including today's three), four stream schedules active for 12 weeks each side of today, and 7,200 historical pickup scenarios across 30 days. Distribution: 5,904 verified, 576 review, 288 rejected, 432 exception scenarios. It also creates actual private synthetic image bytes, categories, complaints, ratings, five external sample certificates, two monthly invoices with a manual payment, and a second isolated tenant. Synthetic records are labelled `DEMO_SYNTHETIC`; these are not real household photographs or civic claims. Five primary aliases use phones `+919000000001` through `+919000000005` in the requested role order. Additional collectors use `+919000000011` through `+919000000015`; the isolation officer uses `+919000000099`.

## Additional Endpoint Map

- `/collector/devices`, `/collector/today`, `/collector/routes/:routeId/stops`, `/collector/pickups/batch`, `/collector/pickups/:id/photos/presign`, `/collector/pickups/:id/photos/:photoId/confirm`, `/collector/stops/:stopId/exception`, `/collector/sync/status`.
- `/supervisor/pickups`, `/supervisor/pickups/:id`, `/supervisor/pickups/:id/review`, `/supervisor/stops/:id/reassign` (`{routeId,reason}`), `/supervisor/devices/:id/revoke`, `/supervisor/complaints`, `/supervisor/dashboard`.
- `/resident/schedule`, `/resident/pickups`, `/resident/pickups/:id`, `/resident/pickups/:id/ratings` (POST and 24-hour PATCH), `/resident/complaints`, `/resident/complaints/:id/reopen`, `/complaints/:id` (GET/PATCH), `/complaints/:id/swachhata`, `/complaint-categories`, `/notifications`, `/notifications/:id`.
- `/societies/:societyId/properties` (GET/POST), `/properties/import`, `/properties/:id` (PATCH), `/properties/qr-sheet.pdf`, `/properties/rotate-qr`, `/residents`, `/residents/invite`, `/residents/:id`, `/schedules`, `/schedules/:id`, `/vendors`, `/collectors`, `/routes`, `/settings`, `/dashboard`, `/complaints`, `/complaints/:id` (PATCH).
- Society invoices: GET list/detail/PDF, POST generate/issue/mark-paid/disputes. Society compliance: summary, eligibility, registration, documents and private download, certificates, handovers and verification, onsite-logs, monthly-log, annual-return and inspection-pack.pdf.
- `/ulb/:ulbId/dashboard`, `/wards`, `/societies`, `/contractors`, `/complaints`, `/complaints/:id/escalate`, `/certificates`, `/audit-log`, `/exports/:type.:format`, `/settings`, `/feature-flags`, `/complaint-categories`, `/complaint-categories/:id`.
- Export types: `pickups|complaints|invoices|payments|certificates|accounts`; formats `csv|xlsx|pdf`. Accounts includes invoice and payment records. CSV neutralizes spreadsheet formulas. Exports reject results over 10,000 records instead of silently truncating.
- `/admin/ulbs` creates a default-off tenant and a server-issued SUPER_ADMIN membership. `/me/privacy-requests` persists an export/erasure request for review, not a false claim that erasure has completed.
- `/webhooks/swachhata` and `/webhooks/whatsapp` accept `{ulbId,eventId,status,complaintId?}`. `X-Signature` is hex HMAC-SHA256 of the exact raw JSON body (optional `sha256=` prefix). With a configured signing secret, bad signatures receive 401; valid payloads are retained and still return 501 NOT_CONFIGURED. No government API is called.
- `/api/v1/healthz`, `/api/v1/readyz`, `/docs`, `/docs/json`. Readiness currently checks PostgreSQL, not external provider readiness.

## Deliberate Boundaries

- SMS OTP, WhatsApp, FCM, government adapters and malware scanning return `NOT_CONFIGURED` rather than claim delivery/scanning.
- EXIF is stripped and images are decoded/re-encoded. Camera source is a client declaration, not hardware attestation. The exact collector upload contract supplies no independent photo timestamp; event capture time is not asserted to be independently verified.
- Inspection PDF contains the evidence register, 12-month logs and original document IDs. It does not merge uploaded binary PDFs; originals remain available from the private document vault.
- Non-image PDFs receive envelope/size validation and private attachment delivery, not a malware-clean claim.
- Accepted exceptions remain distinct from verified weighed collections and cannot inflate kg/coverage. Hard evidence failures cannot be overridden into verified pickups.
- Database records retain exact actor/review/audit history. Reassignment is refused once a stop has recorded pickup evidence. Retention settings and privacy requests are persisted; destructive retention/erasure execution is deliberately not automated.
- `MassBalance` and optional `Vehicle` models are available; mass balance is currently computed from evidence, not materialized by a scheduler. There is no standalone vehicle-management UI/API.
- There is no production SMS provider; non-demo sign-in is intentionally blocked. Redis delivery, S3/MinIO interoperability, PostgreSQL migration execution and the 500-event throughput target have not been measured in this environment.
- Public batch schema is the shared strict Zod schema in OpenAPI. Runtime envelope validation is intentionally broader so malformed events with a valid UUID can be recorded as durable rejections before returning 422. Events without a usable UUID fail envelope processing.
- Unassignable/malformed submissions are retained in `RejectedSubmission`; ULB diagnostics report their count separately from attributable pickup-event quality metrics.
- JSON polygon boundaries are stored for map rendering; this API does not install or query the optional PostGIS extension.

## Verification and Handoff

Latest command outcomes (dependencies installed and Prisma client available):

| Command | Outcome |
| --- | --- |
| `PATH=/tmp/bcode:$PATH pnpm --filter @swachh/api typecheck` | Passed after the refresh-family parameter and `Scope` definite-assignment fixes; passed again with all new tests. |
| `PATH=/tmp/bcode:$PATH pnpm exec eslint apps/api prisma` | Passed, no warnings or errors. |
| `PATH=/tmp/bcode:$PATH pnpm exec vitest run apps/api/tests` | 20 passed, 24 skipped; three test files passed, one skipped. No test failed. PostgreSQL suite skipped because both `TEST_DATABASE_URL` and `DATABASE_URL` are unset. |

The earlier dependency-free SQL generation and externalized syntax bundles passed, but did not execute migrations or prove database behavior. No database was provisioned, no migrations/seeds were run, and no provisioning wait was introduced in this follow-up.

After the root owner supplies a disposable, migrated database, run:

```sh
PATH=/tmp/bcode:$PATH pnpm exec vitest run apps/api/tests
```

Integration tests use `TEST_DATABASE_URL` when set, otherwise `DATABASE_URL`; they skip only when neither is configured. They create uniquely named tenant fixtures and do not reset or delete existing data. Run against a disposable migrated database. The API tests cover cross-tenant HTTP and DB constraints, unknown-field rejection, OTP cooldown/attempt persistence, refresh reuse, device limits, actual image byte confirmation/EXIF stripping, immutable signed uploads, offline idempotency/outbox uniqueness, missing weight/geofence/QR/duplicate-photo rejection, resident scope/ratings, 20-property import/QR PDF, append-only audit, complaint resolution/reopen, exact invoice math/PDF/manual payment, certificate RBAC, annual JSON/PDF/inspection PDF, signed NOT_CONFIGURED webhooks and all three export formats.

The eight added integration cases cover society/ULB pickup pagination and filters, same-tenant sibling-society and foreign-tenant records/cursors, authenticated detail and actual signed photo reads with tamper/expiry rejection, annual-return metadata/year filters, audited accounts CSV contents, resident active-link isolation and role/feature gates. These assertions typecheck but have not executed against PostgreSQL. The 20 passing database-independent tests do not substitute for that verification.
