# @swachh/domain

Pure TypeScript rules for Swachh-Track. Import named exports from `@swachh/domain`.
No database, network, wall-clock reads or global randomness. QR helpers use Node's
crypto module; this package is server-side. Contracts remain browser/mobile-safe.
Both packages export `./src/index.ts` and extend the root strict TypeScript config.

## Integration Contract

1. Authorize and tenant-scope every repository query before calling these rules.
2. Parse incoming requests with `pickupSchema` / `batchSchema` from
   `@swachh/contracts`. `PickupRequest` is the wire input; `PickupInput` is the
   parsed output, with absent exception-only `streams` normalized to `[]`.
3. Resolve the registered device, historical route/date assignment, property,
   current QR key, confirmed photo records and prior image hashes on the server.
   Never turn client-provided metadata or hashes into `VerificationContext`.
4. Enforce UUID/idempotency uniqueness transactionally **before** verification.
   Exclude the same retried event from `priorPhotos`; return its saved response.
5. Persist results, audit transitions and enqueue notifications in one transaction.
   These functions do not replace tenant guards, constraints or outbox delivery.

```ts
import { pickupSchema } from '@swachh/contracts';
import { verifyPickup, type VerificationContext } from '@swachh/domain';

const input = pickupSchema.parse(requestBody);
const context: VerificationContext = await loadTrustedEvidence(input);
const result = verifyPickup(input, context);
// result: { status, score, reasons, distanceM, auditRequested }
// Persist result with capturedAt and server context.receivedAt.
```

`VerificationContext` requires `tenantId`, `collectorId`, `receivedAt`, `property`
(`id`, `tenantId`, coordinates, `qrTokenHash`), `qrKey` (`version`, `secret`),
`device`, `assignment`, `photos`, `priorPhotos`, and `random: () => number`.
Nullable device/assignment means no trusted match. Assignment `date` is an IST
`YYYY-MM-DD`, not the UTC date. Preserve historical assignments for offline sync.
The API can supply `Math.random`; tests inject a fixed value in `[0, 1)`.

Photo evidence requires `id`, `tenantId`, `propertyId`, `collectorId`, `deviceId`,
`kind` (`DOORSTEP`, `SCALE`, `EXCEPTION`), optional `stream`, `captureSource`,
`normalized`, normalized-image `sha256`, and `capturedAt`. The API owns image
re-encoding, EXIF removal, storage access and hashing. `captureSource` is a camera
declaration, not proof against a compromised device. Extra client fields such as
`photoHash`, `capture_source` or `status` are rejected by the strict contract.

## Public Functions

| Export | Exact purpose / main parameters |
| --- | --- |
| `signQrToken(propertyId, key)` | HMAC-SHA256 over `JSON.stringify([version, propertyId])`; returns `base64url(propertyId.signature)` with a base64url signature. |
| `verifyQrToken(token, propertyId, key, storedTokenHash?)` | Canonical token validation and constant-time signature/hash comparison. Only the supplied current version/secret is accepted. |
| `hashQrToken(token)` | SHA-256 hex for storage instead of the QR token. |
| `haversineDistanceM(from, to)` | Great-circle metres for `{ latitude, longitude }`, earth radius 6,371,000 m. |
| `verifyPickup(request, context)` | Returns hard/soft reasons, status, score, distance and audit selection. Accepts `PickupRequest`. |
| `isDuplicatePhoto(sha256, propertyId, receivedAt, previous)` | Same property/hash in `(receivedAt - 24h, receivedAt]`. `previous` contains `{ propertyId, sha256, receivedAt }`. |
| `kgToGrams(kg)` | Exact nonnegative integer grams; rejects values outside numeric(10,3). |
| `sumKg(values)` | Adds kg via integer grams, not floating-point accumulation. |
| `istDate(instant)` | UTC/offset ISO instant to IST `YYYY-MM-DD`. |
| `verifiedStops(stops, events)` | `{ stop, event }` pairs for verified non-exception pickups. Rejects duplicate IDs, multiple verified pickups at one stop and out-of-scope events. |
| `billableMissedStops(stops, events)` | Stops with neither a verified pickup nor an accepted exception. |
| `calculateWeightChargePaise(kg, ratePaisePerKg)` | Integer gram x paise math with BigInt; half-up rounding once per line. |
| `calculateInvoice(input)` | Recomputes service, verified-stop, per-stream handling, deduction and reasoned adjustment lines; returns INR totals in integer paise. See `InvoiceCalculationInput`. |
| `calculateEligibility(input)` | `BWG`, `RWA_DUTIES_ONLY` or `BELOW_THRESHOLD`, reasons, RWA duty flag and ULB disclaimer. Uses parsed `EligibilityInput`. |
| `calculateMassBalance(input)` | Collected/handover/processing gaps, absolute variances, review flag and evidence-gated recycling metric. Each `WasteMeasurement` preserves its own provenance/source IDs. |
| `certificateValidUntil(issuedAt, validityYears = 3)` | Calendar-year default validity; leap day clamps to February 28 when necessary. |
| `certificateExpiryAlert(validUntil, asOf)` | Returns the nearest applicable `90`, `30`, `7`, `EXPIRED`, or `null`; dates are local calendar dates. |
| `canAssignVendor(vendor, onDate)` | Requires active, documented authorisation with inclusive validity dates. |
| `estimateAnnualObligation(events, observedDays, yearDays = 365, verifiedOnsiteWetKg = 0)` | Annual per-stream estimates from verified history; source IDs retained and outputs marked `ESTIMATED`. Wet on-site input is for the same observed period and must already be verified/approved by the server. |
| `calculateCertificateCoverage(input)` | Active, documented, in-date ULB certificate kg for one society vs per-stream obligations; coverage, gaps, IDs and provenance. See `CertificateCoverageInput`. |
| `isScheduledOn(schedule, date)` | Weekly Sunday=0 patterns or every-N-days anchored to `activeFrom`, inclusive active dates. |
| `scheduledWindow(schedule, date)` | Matching day's IST time window as UTC `{ start, end }`, otherwise `null`. |
| `nextScheduledPickup(schedule, from, maxDays = 366)` | First future or ongoing window; bounded search, `null` when absent. |
| `isQuietHours(instant, start = '21:00', end = '07:00')` | IST start-inclusive/end-exclusive quiet hours; equal times disable quiet hours. |
| `notificationDeliveryAt(instant, template, start?, end?)` | Immediate UTC instant or next quiet-hours end. `SLA_BREACH` bypasses quiet hours. |
| `calculateSla(input, now)` | Pause-adjusted due date, active elapsed/remaining ms, pause state, breach and resolved flags. See `SlaInput`. |
| `transitionComplaint(state, action)` | Immutable lifecycle transition with role, reason/photo, pause/resume and seven-day reopen checks; returns `{ complaint, escalation }`. |
| `slaEscalation(sla, now, supervisorNotifiedAt?, ulbDelayMs = 3600000)` | Supervisor first, ULB after configurable delay; resolved cases do not send breach notifications. |
| `assertPickupTransition(from, to, authority)` | Validates pickup progression; server verdict required on sync, supervisor reason for review/correction. Returns target state or throws. |
| `assertStopTransition(from, to, authority)` | Pending to done/exception/skipped; skip requires supervisor reason. |
| `assertInvoiceTransition(from, to)` | Draft to issued/void, issued to paid/void; paid/void terminal. Payment reconciliation/permissions remain API-owned. |
| `ratingPermission(status, now, existingCreatedAt?)` | Verified-only create/edit permission; inclusive 24-hour edit period. API enforces unique `(resident, pickup)`. |
| `calculateDashboardMetrics(input)` | Central coverage, missed/on-time, quantities, segregation, contamination, complaints/SLA, certificates, costs and data-quality formulas. Every `Metric` has value, unit, definition, provenance and source IDs. |
| `calculateWeeklyWaste(events, asOf, weeks = 12)` | Monday-start IST weekly verified kg by stream; excludes future events, fills empty weeks. |
| `calculateDestinationWaste(handovers)` | Per-destination/stream verified handover kg with registered-vendor receipt provenance; never labels mere handover as recycling. |

Exported adapters: `ScaleAdapter`, `ManualScaleAdapter.read({ kg, photoId })`
returns manual/self-reported readings; `ContaminationScorer` and
`NoopContaminationScorer.score(photoId)` explicitly return `NOT_MEASURED`.
There is no simulated Bluetooth integration or image classification.

All public input/result types are exported from `src/index.ts`, including
`QrKey`, `Coordinates`, `VerificationContext`, `VerificationConfig`,
`PhotoEvidence`, `PriorPhotoEvidence`, `VerificationReason`, `VerificationResult`,
`OperationEvent`, `ScheduledStop`, `InvoiceRates`, `InvoiceLine`,
`InvoiceCalculationInput`, `InvoiceCalculation`, `EligibilityResult`,
`WasteMeasurement`, `MassBalanceInput`, `CertificateRecord`,
`CertificateCoverageInput`, `SlaPause`, `SlaInput`, `SlaResult`, `ComplaintState`,
`ComplaintTransition`, `ComplaintTransitionResult`, `TransitionAuthority`,
`Metric`, `DashboardInput`, `DestinationHandover`, `ScaleReading`, plus shared contract types.

## Deliberate Rules

- QR version is trusted server-side key metadata, not an extra payload field.
  Changing the version, even with the same secret, invalidates old signatures.
  There is no implicit old-key grace period. Production secrets must be random.
- Geofence `> 75m` is hard rejection; accuracy `> 50m` is soft review. Both are
  configurable. Equality passes. Timestamp/GPS/photo mismatch uses `> 5min`.
- All stream weights must be positive; every collected stream needs its own
  confirmed scale/bin image and the event needs a doorstep image. Exceptions
  without streams need their exception note/photo but not fictitious weights.
  Every valid exception remains `NEEDS_REVIEW`, never a verified collection.
- Hard failures always score 0. Soft penalties: GPS accuracy/staleness/photo-time
  20 each, capture/receive gap 15, offline 15, exception 30, random audit 5.
  A reason code is charged once; scores clamp at zero. Audit only otherwise-clean
  events with sample `< auditRate` (default 0.05).
- Receive/capture skew cannot distinguish delayed sync from a bad device clock.
  It is always a review flag, not a claim of known clock error. Duplicate checks
  use server receive time, so clients cannot evade the window by backdating.
- Operational inputs to invoices/metrics must be tenant-and-period-scoped by
  the API. Each operational invoice line carries event/stop IDs; flat counts
  require an auditable query reference. Unsafe integers/negative payable totals
  throw. Negative totals need a separate credit workflow.
- Billing deductions follow section 3.8: no verified event **and no accepted
  exception**. Dashboard missed counts instead follow section 3.10: `NOT_OUT`
  or no event, once per stop, excluding verified stops. These are not synonyms.
- RWA duty threshold is strictly `> 5000`; BWG thresholds are inclusive
  `>= 20000 sqm`, `>= 40000 litres/day` or `>= 100 kg/day`. Flat count has no
  invented threshold. Floor area is the supplied area proxy for RWA eligibility;
  final interpretation belongs to the ULB.
- Mass balance compares collected vs handover, handover vs processed, and
  collected vs processed. Absolute variance strictly `> 5%` triggers review.
  Zero denominators produce `null`; nonzero downstream quantities still flag an
  anomaly. Recycling needs verified quantities, a registered-processor receipt
  and a plausible quantity chain; otherwise `NOT_MEASURED`.
- Certificate expiry is inclusive through the local calendar day. Coverage is
  uncapped (can exceed 100%); zero obligation gives `null`, not automatic 100%.
  Gaps are per-stream, so wet surplus never hides a dry deficit. Estimates retain
  their provenance; no claim of compliance, certificate issuance or submission.
- SLA categories/hours are supplied by the database, never hardcoded category
  mappings. Only reasoned resident-wait intervals pause time. Deadline equality
  is on time. Resolution freezes the clock. Reopening keeps original creation/
  SLA history, increments once and escalates to supervisor; a second valid reopen
  request leaves state unchanged and returns `ULB_ADMIN` for a queue task.
- Schedule windows are same-day IST; overnight windows must be split by the API.
  Multi-stream segregation event categories overlap and say so in the definition;
  kg categories do not overlap. SLA compliance denominator is resolved complaints.
  Invoice costs include issued/paid only. Undefined denominators/no invoices
  are `NOT_MEASURED`. Ward/contractor views call the same formulas on scoped data.

## Tests And Boundaries

From the workspace root after the main owner installs dependencies:

```sh
pnpm --filter @swachh/contracts typecheck
pnpm --filter @swachh/domain typecheck
pnpm exec vitest run packages/domain packages/contracts
pnpm exec eslint packages/domain packages/contracts
```

Fixed-fixture tests accompany QR/rotation/tampering, geography, every verification
evidence branch, exception-only requests, scoped 24-hour duplicates, audit draws,
integer billing/provenance/rounding, eligibility boundaries, certificates, mass
balance, complaint/SLA/reopen, schedules/quiet hours, state transitions, adapters,
every implemented dashboard metric, 12-week trends, strict contracts and API client.

These are unit tests, not end-to-end acceptance. Database tenant isolation,
idempotent concurrency, actual image normalization, government adapters, upload
ownership, transactions/outbox, PDFs/exports, ward/contractor query scoping, routes,
mobile offline persistence and production integrations belong to the other apps.
