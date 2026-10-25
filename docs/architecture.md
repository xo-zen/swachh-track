# Architecture

## System Shape

Swachh-Track is a modular monolith with two clients and a separately started notification worker, not a fleet of microservices.

```text
Next.js web console ---------------------> Fastify /api/v1
  same-origin Next rewrite                    |
Expo Android collector ----------------------+
  SecureStore + SQLite + durable JPEGs          |
                                              +--> Prisma --> PostgreSQL 16
Clients <--> five-minute signed capabilities --+--> local files OR private S3
                                              |
PostgreSQL notification outbox --> BullMQ/Redis 7 worker
                                      |
                                      +--> in-app status/attempt records
                                      +--> explicit unconfigured provider results
```

| Source                                                         | Responsibility                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/api/src/app.ts`, `server.ts`, `config.ts`                | Fastify setup, strict request schemas, error handling, configuration, health, generated OpenAPI      |
| `apps/api/src/core.ts`, `auth.ts`                              | Authentication, current membership, scoped predicates, roles, audit, transaction locks, OTP/refresh  |
| `registry.ts`, `pickups.ts`, `storage.ts`                      | Registry, routes, evidence normalization, durable submissions and reviews                            |
| `operations.ts`, `billing.ts`, `compliance.ts`, `reporting.ts` | Resident workflows, complaints, invoicing, evidence registers, reporting                             |
| `analytics.ts`                                                 | Maps scoped database records into shared domain inputs                                               |
| `worker.ts`                                                    | PostgreSQL outbox scan, BullMQ delivery attempts, reminders and SLA escalation                       |
| `apps/web`                                                     | Next 15.5.14 / React 19.1 console, TanStack Query, MapLibre, Recharts, English/Hindi controls        |
| `apps/collector`                                               | Expo 54 / React Native 0.81.5, foreground camera/GPS, SQLite queue and evidence upload               |
| `packages/contracts`                                           | Zod schemas, shared vocabulary/types and API client                                                  |
| `packages/domain`                                              | Pure verification, money, schedules, SLA, compliance and metric calculations; Node crypto QR helpers |
| `packages/ui`                                                  | Web UI components                                                                                    |
| `prisma`                                                       | 43 models, three migrations, fictional seed entrypoint                                               |

Some route DTOs are defined directly in API modules rather than using similarly named contract exports. The registered route and generated OpenAPI are authoritative for HTTP requests; see [API differences](api.md#contract-authority).

## Tenancy And Persistence

`Ulb -> Ward -> Society -> Property` is the registry hierarchy. A global `User` has active `Membership` records carrying role, ULB, and optional society/contractor scope. Resident-property links and collector-contractor assignments further restrict visibility. `SUPER_ADMIN` is still scoped to the selected membership's ULB, not an automatic cross-tenant query bypass.

`authenticate` verifies an access JWT and rereads active user/membership records. Clients send `X-Membership-Id`; if absent, the server currently chooses the earliest active membership. A tenant ID in a path/query never grants access. Foreign resources normally appear as 404; unauthorized roles/memberships as 403.

All operational records carry `ulbId`. Scoped application queries are supplemented by deferred same-tenant reference triggers in migration 003. This is **not PostgreSQL row-level security**. Migration 002 adds positive-weight/payment, date/score/coordinate checks, one verified weighed event per stop, and append-only audit/complaint-history triggers. Database administrators are still trusted; these triggers are not tamper-proof external archival.

Money is integer INR paise. Stored kg uses `numeric(10,3)`; domain summation/charging uses integer grams and explicit rounding. Instants use timezone-qualified timestamps; service dates, schedule windows and display are interpreted in Asia/Kolkata. Invoice periods must be a complete calendar month. Annual returns use an April-to-March financial year.

## Capture To Verified Evidence

1. Collector authenticates online, selects membership, binds a stable device UUID and caches today's ordered assigned routes. At most two active devices are allowed per collector.
2. Camera QR scanning or a selected-stop six-digit fallback resolves identity. The cached route already contains signed QR tokens: this is usable offline but not strong proof of physical presence.
3. The app gathers fresh foreground GPS, a doorstep image and separate scale image/manual positive kg for each scheduled stream. An exception uses note/photo and no invented zero-weight collection.
4. Resized JPEGs are copied into the app's durable directory. SQLite persists draft references; an exclusive transaction saves immutable event/photo records and removes the draft. Scope is `userId:membershipId`.
5. Foreground sync advances each image through `LOCAL -> PRESIGNED -> UPLOADED -> CONFIRMED`. It checkpoints each step, renews expired upload capabilities, and avoids reuploading confirmed evidence.
6. After confirmation, the wire event is frozen once. The app sends sequential single-event batches with `client_uuid` as `Idempotency-Key`. The server supports up to 500 events in a batch, but that is not a demonstrated mobile throughput result.
7. The API serializes tenant sync using a PostgreSQL advisory transaction lock. It validates evidence from database-owned photo records, not client hashes. It persists verdicts, audit, notifications and the idempotent response transactionally.
8. Offline capture always requires review. A reasoned supervisor approval can turn a valid weighed `NEEDS_REVIEW` event into `VERIFIED`. Hard failures cannot be approved. An accepted exception remains distinct from verified kg.

On restart, `SYNCING` recovers to pending; retry uses immutable UUID/payload and saved photo checkpoints. Backoff starts at five seconds and caps at one hour. Sync is foreground-only and single-flight. Sign-out preserves local queues and evidence. Neither local event/photo retention nor unsynced-data recovery after uninstall/clear-data is automatic.

`SYNCED` means transport acknowledgement, not verification. PostgreSQL persists `VERIFIED`, `NEEDS_REVIEW` or `REJECTED`. Invalid attributable events remain pickup records; malformed/unassignable events with usable UUIDs remain `RejectedSubmission` records. Reusing the same batch key/content replays its original response, including 422. A reused key with changed content or a UUID under another key produces 409.

## Evidence Storage

Local storage serves signed PUT/GET capabilities through the API and is limited to development/test. S3 uses separate internal and client-reachable endpoints with five-minute presigned URLs. Photos are reserved before upload; confirmation decodes actual bytes with Sharp, strips metadata by reencoding, and hashes the normalized image. Normalized outputs use different keys from upload reservations. Server image dimensions are bounded to 1600 pixels per side and decoded inputs to 25 million pixels; uploads are capped at 8 MiB.

General web uploads support images/PDF and never need to claim camera origin. PDF validation is limited to envelope/size checks; malware scanning is `NOT_CONFIGURED`. Images, QR, GPS and client timestamps remain evidence signals, not hardware attestation. There is no independent photo timestamp in the collector HTTP contract.

## Operations And Derived Data

- Complaint categories supply SLA hours, snapshotted on creation. Resolution requires confirmed evidence; reasoned resident-wait intervals pause SLA. Reopen preserves history and drives escalation.
- Billing snapshots active-flat count, verified pickup/weight evidence, eligible missed-stop deductions and rates into immutable application-facing invoice lines. Generation, issue and manual payment are separate operations. Disputes create review records, not automatic credits.
- Compliance uses provenance-bearing quantities, external documents/certificates, estimated obligations and draft annual snapshots. `MassBalance` exists as a model, but current balances are calculated on read, not periodically materialized.
- Dashboards use common domain functions after API scoping. The web renders server results rather than implementing competing formulas. Undefined denominators remain unmeasured, not fabricated zeros.
- MapLibre displays API-returned coordinates/valid boundaries over OpenStreetMap tiles. Seed boundaries are fictional. No WebSocket/SSE feed, live vehicle telemetry or realtime map tracking is implemented; views refresh through queries/navigation/actions.

## Worker And External Boundaries

The API writes notification rows in the same transaction as supported business operations. The worker scans due pending rows every ten seconds (up to 250 per scan), adds deduplicated BullMQ jobs, uses concurrency five, and retries delivery transactions up to five times. Delivery attempts are persisted. It also scans upcoming stops, breached complaints and expiring certificates. This is bounded polling, not an exactly-once external-delivery guarantee or a measured high-volume scheduler.

Default quiet hours are 21:00-07:00 IST; `SLA_BREACH` bypasses them. In-app records are real; development email only logs; production email, WhatsApp and FCM are unconfigured. Swachhata endpoints record explicit disabled integration outcomes, not government delivery. Redis-worker execution is pending the main owner's verification update.

## Deployment Boundaries

`pnpm dev` starts API/web/Expo, **not** the worker. Next rewrites `/api/v1` through server-only `API_INTERNAL_URL`. Public API/storage URLs must be reachable by the caller; localhost and Docker network names are not interchangeable. Web tokens are memory-only and a page reload requires sign-in; Expo tokens/device ID use SecureStore, while SQLite/JPEGs use the app sandbox rather than SQLCipher.

The Dockerfile and Compose stack are authored development packaging and have not run here. Plain PostgreSQL 16 works; Compose chooses a PostGIS image but no migration installs or queries the extension. Readiness only probes PostgreSQL. Production OTP/provider onboarding, S3 validation, shared rate limiting, native-device tests, retention execution, backups/restore drills and capacity measurement remain release work, not features established by passing unit tests.
