# API

## Contract Authority

Business routes are mounted at `/api/v1`. With the API running, `/docs` serves Swagger UI and `/docs/json` serves generated OpenAPI from registered Zod request schemas. There is no checked-in static OpenAPI artifact. The generated document is a request-schema reference, not a promise that every response model, header requirement or role policy is fully described there.

Read the actual route module when integrating. Several similarly named shared schemas are **not** the registered HTTP DTO:

| Operation                   | Actual HTTP contract                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| OTP verify                  | `{phone,code}`, not `{phone,otp}`                                                                                               |
| Device registration         | `{deviceId,platform,appVersion}`; app sends `android`, route accepts a bounded string                                           |
| Collector photo reservation | `{kind,stream?,captureSource:"CAMERA",contentType:"image/jpeg"}`; no `sizeBytes` or independent photo `capturedAt`              |
| Photo confirmation          | ID in URL, body `{}`; not a body containing `photoId`                                                                           |
| Vendor creation             | `type`, `authorizationNumber`, ISO-offset `validUntil`, `documentId`, optional `contractorId`; not `kind`/`authorisationNumber` |
| Onsite log                  | `asset,capacityKg,date,inputKg,outputKg,downtime?,photoId`; not `assetId`/`downtimeHours`                                       |
| Profile preferences         | `notificationPreferences:{inApp,email,whatsapp}`; no editable quiet-hour fields on this route                                   |

Sources: `apps/api/src/{auth,registry,pickups,storage,operations,billing,compliance,reporting}.ts` and `packages/contracts/src/index.ts`.

## Authentication And Errors

### Open Demo (`NO_AUTH=true`)

Public `GET /api/v1/access` requires no credentials and returns `Cache-Control: no-store`. In open-demo mode its response is:

```json
{
  "mode": "open-demo",
  "roles": [
    { "alias": "resident", "role": "RESIDENT" },
    { "alias": "society", "role": "SOCIETY_ADMIN" },
    { "alias": "collector", "role": "COLLECTOR" },
    { "alias": "supervisor", "role": "SUPERVISOR" },
    { "alias": "ulb", "role": "ULB_ADMIN" }
  ]
}
```

Otherwise it returns `{"mode":"authenticated","roles":[]}`. Web and collector discover this automatically; no frontend mode flag is needed. `NO_AUTH=true` requires `NODE_ENV=development` and `DEMO_MODE=true` and supports either fictional seed profile. `.env.example` and `render.yaml` enable it; the hosted launcher defaults it to `true` unless explicitly `false`, while plain API configuration defaults to `false`.

```sh
curl --fail-with-body http://localhost:4000/api/v1/access
curl --fail-with-body http://localhost:4000/api/v1/me \
  -H 'X-Demo-Role: resident'
```

Send `X-Demo-Role` on business API requests, including downloads and upload reservation/confirmation, without a bearer token. It must exactly match one of the five short aliases above, not an email or role enum. Missing/invalid aliases return 403 `DEMO_ROLE_INVALID`. The server resolves the exact active seeded user/membership, tenant and scope and requires the fictional seed marker; altered identities are rejected. Optional `X-Membership-Id` must match that membership. Normal role/tenant checks remain; neither `SUPER_ADMIN` nor another tenant can be selected.

This is public role selection, not visitor authentication: anyone can act as any of the five shared demo identities, including admins. Use fictional data only. `PATCH /me`, resident invitations and resident activation/deactivation return 403 `HOSTED_DEMO_IDENTITY_LOCKED`. OTP request/verify, refresh and logout return 403 `AUTH_DISABLED`; open-demo clients do not call them. Signed file capabilities and QR signing remain required; direct signed storage requests do not carry API identity headers.

### Authenticated Mode (`NO_AUTH=false`)

Explicitly disable open-demo access and restart the API to use the retained OTP/token flow:

```sh
curl --fail-with-body -X POST http://localhost:4000/api/v1/auth/otp/request \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+919000000002"}'

curl --fail-with-body -X POST http://localhost:4000/api/v1/auth/otp/verify \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+919000000002","code":"123456"}'
```

These are runnable only against the seeded development/demo server with `NO_AUTH=false`. Verification returns `{accessToken,refreshToken,user,memberships}`. The following example assumes `ACCESS_TOKEN`, `MEMBERSHIP_ID` and resource IDs are taken from that response and authorized list endpoints, not invented UUIDs.

```sh
curl --fail-with-body http://localhost:4000/api/v1/me \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Membership-Id: $MEMBERSHIP_ID"
```

In authenticated mode, send both headers on business requests; `X-Demo-Role` is not an authentication alternative. The server validates membership ownership and scope; absent `X-Membership-Id` currently falls back to the earliest active membership. Clients should select explicitly. Access JWT lifetime is 15 minutes; refresh tokens expire after 30 days and rotate on use. Refresh-token reuse revokes the family. Logout revokes the refresh family but does not immediately invalidate an already-issued access JWT.

OTP expires after five minutes, permits five verification attempts, has a 60-second request cooldown and a five-request-per-phone/hour database-backed limit. Request/verify also have process-local IP limits. Non-demo sign-in returns 503 `OTP_PROVIDER_NOT_CONFIGURED`; production rejects demo mode. No request auto-provisions a new user.

### Errors And Common Conventions

Standard failures use:

```json
{
  "error": {
    "code": "FEATURE_DISABLED",
    "message": "billing_v1 is disabled for this ULB.",
    "requestId": "req-..."
  }
}
```

`details` may contain validation issues or original idempotent results. Common statuses: 401 invalid auth, 403 role/membership/feature denial, 404 inaccessible/missing record, 409 conflict, 413 oversized upload/export, 422 validation/evidence/state failure, 429 rate limit, 501 unconfigured integration, 503 unavailable provider/storage. **Batch evidence rejection is a deliberate exception:** HTTP 422 may directly contain `{results:[...]}` rather than `error`.

Paginated lists generally return `{data,nextCursor}` with default limit 25 and maximum 100. Send supported filters only; strict query/body schemas reject unknown fields. Filter support differs by endpoint; do not assume every accepted pagination field is implemented on every list. Pickup-history filters include status, capture-time `from/to`, ward and society. Annual-return lists filter generation time and `financialYearStart`; resident properties support unit/block search. On those scoped lists, inaccessible/out-of-filter cursors return 404.

Dates are `YYYY-MM-DD`; instants must include UTC or an offset. Money inputs are integer paise; kg is positive with at most three decimals for pickup streams. JSON request bodies are normally limited to 2 MiB; binary uploads to 8 MiB.

## Auth And Personal Routes

All paths below omit `/api/v1`.

The `/auth/*` routes below require `NO_AUTH=false`. Identity mutation locks also apply when `HOSTED_DEMO=true`, even with authentication enabled.

| Method      | Path                   | Input / behavior                                                                  |
| ----------- | ---------------------- | --------------------------------------------------------------------------------- |
| GET         | `/access`              | Public mode discovery: `open-demo` with five `{alias,role}` entries, or `authenticated` with `roles:[]` |
| POST        | `/auth/otp/request`    | `{phone}`; 202 with expiry/cooldown; demo returns `demoCode`                      |
| POST        | `/auth/otp/verify`     | `{phone,code}`; tokens and memberships                                            |
| POST        | `/auth/refresh`        | `{refreshToken}`; replace both returned tokens                                    |
| POST        | `/auth/logout`         | `{refreshToken}`; revoke refresh family                                           |
| GET / PATCH | `/me`                  | Read identity/scope; patch name, email, `en`/`hi` locale or preferences; PATCH locked in open/hosted demo |
| POST        | `/me/privacy-requests` | `{type:"EXPORT"}` or `ERASURE`; 202 review request, not completed export/deletion |
| GET         | `/notifications`       | Current user's delivered in-app records; worker must process outbox               |
| PATCH       | `/notifications/:id`   | `{read:true}`                                                                     |
| GET         | `/healthz`, `/readyz`  | Liveness; PostgreSQL-only readiness                                               |

## Registry And Routes

Unless stated otherwise, these society routes allow `SOCIETY_ADMIN`, `ULB_ADMIN` and `SUPER_ADMIN` within their scope. Let `S` mean `/societies/:societyId`.

| Method     | Path                        | Input / behavior                                                              |
| ---------- | --------------------------- | ----------------------------------------------------------------------------- |
| GET / POST | `S/properties`              | Create `{unitNo,block?,floor?,latitude,longitude,status?}`                    |
| PATCH      | `S/properties/:id`          | Nonempty subset of property fields                                            |
| POST       | `S/properties/import`       | `{csv:"unitNo,block,floor,latitude,longitude,status\n..."}`; validated import |
| GET        | `S/properties/qr-sheet.pdf` | `limit` 1-240, default 20; signed QR PDF                                      |
| POST       | `S/properties/rotate-qr`    | `{}`; rewrite property hashes using configured current QR secret/version      |
| GET        | `S/residents`               | Resident links                                                                |
| POST       | `S/residents/invite`        | `{phone,name,propertyId}`; create/link resident, not delivered SMS invitation; locked in open/hosted demo |
| PATCH      | `S/residents/:id`           | `{active:boolean}`; locked in open/hosted demo                                  |
| GET / POST | `S/schedules`               | Full schedule body below                                                      |
| PATCH      | `S/schedules/:id`           | Full schedule body, not a partial patch                                       |
| GET / POST | `S/vendors`                 | POST `{name,type,authorizationNumber,validUntil,documentId,contractorId?}`    |
| GET        | `S/collectors`, `S/routes`  | Registry/dated route lookup                                                   |
| POST       | `S/routes`                  | `{name,date,collectorId,vendorId,propertyIds}`; order follows property IDs    |
| PATCH      | `S/settings`                | Full fee/payment/source settings; schema in OpenAPI                           |

Schedule example (replace dates for the intended service period):

```json
{
  "stream": "WET",
  "pattern": { "type": "WEEKLY", "weekdays": [0, 1, 2, 3, 4, 5, 6] },
  "windowStart": "07:00",
  "windowEnd": "11:00",
  "activeFrom": "2026-10-25",
  "activeTo": "2026-11-25"
}
```

Sunday is 0. Alternative pattern: `{"type":"EVERY_N_DAYS","everyNDays":4}` anchored at `activeFrom`. Windows must end later on the same IST day. Route creation derives streams/windows from applicable schedules and requires a valid documented vendor and in-date contractor. Updating schedules does not rebuild existing dated routes. QR rotation with unchanged secret/version does not create a new cryptographic token; coordinated key/version changes, regeneration and client recaching are required.

## Files And Collector Sync

### Web Files

1. `POST /files/presign` with `{filename,contentType,size,purpose}`. Types: JPEG, PNG, WEBP, PDF. Purposes: `COMPLAINT`, `RESOLUTION`, `COMPLIANCE`, `DOCUMENT`, `PROCESSING`, `HANDOVER`. Collector role must use its camera route instead.
2. Receive `{fileId,uploadUrl,expiresIn:300}`. PUT actual bytes to `uploadUrl` with the reserved content type and **without** API authorization headers.
3. `POST /files/:id/confirm {}`. The server verifies actual size/bytes, normalizes images, and returns confirmed IDs/hash/storage key. Use an image `fileId` as complaint/resolution `photoId`; PDF is document-only.
4. For a compliance document, submit that owned confirmed `fileId` or returned storage key as `storageKey`. Arbitrary object paths are not accepted. Read private documents through their role-scoped download endpoint, then fetch its signed URL without API identity headers.

### Collector Evidence

| Method | Path                                             | Purpose                                                                          |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| POST   | `/collector/devices`                             | Register stable `{deviceId,platform,appVersion}`                                 |
| GET    | `/collector/today`                               | `{routes:[...]}` for current IST date, assigned collector only                   |
| GET    | `/collector/routes/:routeId/stops`               | Current assigned route with ordered stops                                        |
| POST   | `/collector/pickups/:id/photos/presign`          | `:id` is the **client event UUID**, allocated before server event creation       |
| POST   | `/collector/pickups/:id/photos/:photoId/confirm` | Confirm actual JPEG upload; body `{}`; confirmation is repeatable                |
| POST   | `/collector/pickups/batch`                       | `{events:[...]}`, 1-500, `Idempotency-Key` required                              |
| POST   | `/collector/stops/:stopId/exception`             | Full pickup event with exception and matching stop; same idempotency requirement |
| GET    | `/collector/sync/status`                         | Paginated `{data,nextCursor,rejectedSubmissions}` of own verdicts                |

Reserve doorstep with `{"kind":"DOORSTEP","captureSource":"CAMERA","contentType":"image/jpeg"}`; a scale reservation also needs `"kind":"SCALE","stream":"WET"`. PUT bytes, then confirm, before submitting the event. Reservations/capabilities expire in five minutes. Presign does not attest a camera or independently verify capture time.

An event has these fields; angle-bracket values are placeholders to replace from actual route/device/upload responses:

```json
{
  "client_uuid": "<immutable-client-uuid>",
  "propertyId": "<assigned-property-uuid>",
  "routeStopId": "<assigned-stop-uuid>",
  "deviceId": "<registered-device-id>",
  "qrToken": "<signed-property-token>",
  "capturedAt": "2026-10-25T08:00:00+05:30",
  "latitude": 18.5204,
  "longitude": 73.8567,
  "accuracyM": 10,
  "gpsCapturedAt": "2026-10-25T08:00:00+05:30",
  "offline": true,
  "doorstepPhotoId": "<confirmed-doorstep-photo-uuid>",
  "streams": [
    {
      "stream": "WET",
      "kg": 1.25,
      "segregation": "GOOD",
      "contamination": false,
      "photoId": "<confirmed-scale-photo-uuid>"
    }
  ]
}
```

Use actual measured location, time and weights, not the illustrative values above. Streams: `WET|DRY|SANITARY|SPECIAL_CARE`; segregation: `GOOD|PARTIAL|MIXED`. Contamination requires `contaminationNote`. For an unweighed exception use `streams:[]` and `exception:{code,note,photoId}`; the collector app requires doorstep and exception evidence. Codes: `NOT_OUT|ACCESS_BLOCKED|CONTAMINATED|WRONG_STREAM|QUANTITY_DISPUTE|WEIGHT_UNAVAILABLE|OTHER`.

`Idempotency-Key` is 8-200 characters. Keep both key and event payload unchanged on retry. Success or durable rejection returns results with `client_uuid,id,status,verificationScore,verificationReasons`. Same key/content replays original HTTP code/body; changed content returns 409 `IDEMPOTENCY_MISMATCH`; UUID reused under a different key returns 409 `CLIENT_UUID_EXISTS` with accessible originals in `error.details.original`. A malformed event without a usable UUID fails envelope validation and cannot be durably keyed. A mixed batch can persist valid events while returning 422 because another event was rejected; inspect each result, not only HTTP success.

### Review And Evidence Reads

| Method | Path                                             | Access / body                                                                  |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| GET    | `/supervisor/pickups`, `/supervisor/pickups/:id` | Supervisor/ULB/super; list is the `NEEDS_REVIEW` queue, not all-status history |
| POST   | `/supervisor/pickups/:id/review`                 | Same roles; `{decision:"APPROVE" or "REJECT",reason}`                          |
| POST   | `/supervisor/stops/:id/reassign`                 | `{routeId,reason}`; same date; refuses stops with recorded evidence            |
| POST   | `/supervisor/devices/:id/revoke`                 | `{reason}`; DB device record UUID, not client device string                    |
| GET    | `S/pickups`, `/pickups/:id`                      | Society/ULB/super; scoped history/detail                                       |
| GET    | `/ulb/:ulbId/pickups`                            | ULB/super scoped history                                                       |

Offline or poor-accuracy evidence is `NEEDS_REVIEW`, never immediately verified. Hard evidence failures cannot be overridden. Approval of an exception records `exceptionAccepted` but leaves it `NEEDS_REVIEW`; it is not a weighed collection. Evidence detail returns short-lived private image URLs.

## Resident And Complaints

Resident-only routes: `GET /resident/properties`, `/resident/schedule`, `/resident/pickups`, `/resident/pickups/:id`; `POST` and `PATCH /resident/pickups/:id/ratings` with `{punctuality,quality,guidance,comment?}`. Scores are 1-5, creation requires a verified non-exception pickup, and edits are limited to 24 hours after rating creation.

`GET /complaint-categories` returns current active categories. `POST /resident/complaints` takes `{propertyId,pickupEventId?,categoryId,description,photoId}` with an owned confirmed image. Lists exist at `/resident/complaints`, `S/complaints`, `/supervisor/complaints`, and `/ulb/:ulbId/complaints`, with role/scope checks. `GET /complaints/:id` includes history, evidence and SLA calculation.

Resolvers (society admin, supervisor, ULB/super admin) use `PATCH /complaints/:id` or `S/complaints/:id` with `{status,note?,photoId?}`. Normal progression is `OPEN -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED`; reasoned waiting/resume/close/reopen branches are enforced by the domain state machine. Resolution requires a confirmed `RESOLUTION` image and note. Resident reopen is `POST /resident/complaints/:id/reopen {note}` within seven days of resolution. A second eligible reopen escalates to ULB rather than silently cycling state.

## Billing And Compliance

Society admin/ULB/super routes require the applicable tenant flag. Let `I = S/invoices` and `C = S/compliance`.

| Method     | Path                                             | Body / result                                                                                         |
| ---------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| GET        | `I`, `I/:id`, `I/:id.pdf`                        | Invoices, evidence lines/payments, PDF                                                                |
| POST       | `I/generate`                                     | `{periodStart,periodEnd,dueDate,adjustmentPaise?,adjustmentReason?}` + idempotency key; creates DRAFT |
| POST       | `I/:id/issue`                                    | `{}`; DRAFT to ISSUED                                                                                 |
| POST       | `I/:id/mark-paid`                                | `{amountPaise,paidAt,reference}`; partial stays ISSUED, exact balance becomes PAID                    |
| POST       | `I/:id/disputes`                                 | `{lineId,reason}`; review record, not refund                                                          |
| GET        | `I/export.csv`                                   | Audited accounts CSV; period-start/status/ward/society filters; payments for selected invoices        |
| GET / POST | `C/documents`                                    | POST `{type,number,issuedBy,issuedAt,validUntil?,storageKey}`                                         |
| GET        | `C/documents/:id/download`                       | `{url,expiresIn:300,scanStatus:"NOT_CONFIGURED"}`                                                     |
| GET        | `C/summary`                                      | Eligibility, registration, estimated obligation, certificates, balances                               |
| POST       | `C/eligibility`                                  | `{floorAreaSqm,waterLitresPerDay,wasteKgPerDay,flats,isRwaOrGatedCommunity?}`                         |
| PATCH      | `C/registration`                                 | `{cpcbStatus,registrationNumber,registeredAt,renewalDate,documentId}`; local record only              |
| GET / POST | `C/certificates`                                 | POST is ULB/super only: `{certificateNo,stream,kg,issuedAt,validUntil?,documentId}`                   |
| GET / POST | `C/handovers`                                    | POST `{date,vendorId,stream,kg,receiptNumber,documentId,destination}`                                 |
| POST       | `C/handovers/:id/verify`                         | ULB/super only; `{reason}`                                                                            |
| GET / POST | `C/onsite-logs`                                  | POST `{asset,capacityKg,date,inputKg,outputKg,downtime?,photoId}`; SELF_REPORTED                      |
| GET        | `C/monthly-log`                                  | Paginated verified non-exception pickup records; `from/to` filters                                    |
| POST       | `C/annual-return`                                | `{financialYearStart}` + idempotency key; one draft per society/year                                  |
| GET        | `C/annual-returns`                               | Paginated draft metadata                                                                              |
| GET        | `C/annual-return/:id`, `C/annual-return/:id.pdf` | Stored JSON snapshot / draft PDF                                                                      |
| GET        | `C/inspection-pack.pdf`                          | Evidence register; original document IDs, not embedded originals                                      |

Payments must be positive, not exceed outstanding balance, and cannot be in the future beyond allowed skew. Retrying payment is not an idempotent batch operation; check recorded payments first. Duplicate invoice-month/annual-year creation returns 409. Detailed legal/evidence limits are in [compliance](compliance.md).

## ULB, Exports And Adapters

ULB/super routes use `/ulb/:ulbId`: `GET /dashboard`, `/wards`, `/societies`, `/contractors`, `/certificates`, `/audit-log`; `POST /wards`, `/societies`, `/certificates`; `PATCH /settings`; `POST /complaints/:id/escalate {reason}`; `POST /complaint-categories` and `PATCH /complaint-categories/:id`. Certificate POST additionally needs `societyId`. Society dashboard is `GET S/dashboard`; contractor-scoped supervisor dashboard is `GET /supervisor/dashboard` for `SUPERVISOR`.

`PATCH /ulb/:ulbId/feature-flags` is `SUPER_ADMIN` only and requires all four booleans: `billing_v1,compliance_v2,whatsapp_v1,swachhata_v1`. `POST /admin/ulbs {name,state,code}` also requires super admin and creates a default-off tenant and membership. There is no public super-admin signup or seeded primary super-admin login.

`GET /ulb/:ulbId/exports/:type.:format` supports `pickups|complaints|invoices|payments|certificates|accounts` and `csv|xlsx|pdf`. Authorization/feature checks apply. Exports reject more than 10,000 rows rather than silently truncate; accounts counts both invoice and payment rows. CSV formula-like values are neutralized. Export filters are resource-specific; timestamps mean capture, creation, issue, payment or period-start depending on type.

`POST /complaints/:id/swachhata {}` retains a local outbound payload and returns 501 `NOT_CONFIGURED`. Webhooks `/webhooks/swachhata` and `/webhooks/whatsapp` take `{ulbId,eventId,status,complaintId?}`. `X-Signature` is hex HMAC-SHA256 of the exact raw JSON body (optional `sha256=` prefix), using the configured channel secret. Missing configuration returns 501, bad signature 401, and valid signatures still return 501 after retaining the payload. No government/messaging status is actually updated.
