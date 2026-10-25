# Web integration handoff

Only `apps/web` and `packages/ui` are owned by this implementation.
Next is pinned to registry-verified `15.5.14`; all other requested versions are pinned.
Root owns installation, lockfile and browser acceptance. The web worker ran the production build after dependencies were installed, as requested in the follow-up.

## Same-origin API and remote browser

- Browser requests default to `/api/v1`. `NEXT_PUBLIC_API_URL` still overrides this; leave it unset or set it to `/api/v1` when browsing through the web tunnel.
- Next rewrites `/api/v1/:path*` to `${API_INTERNAL_URL || 'http://localhost:4000'}/api/v1/:path*`. `API_INTERNAL_URL` is server-only and must be an origin without the API path. The generated production routes manifest was inspected and contains the default rewrite.
- Set public client configuration before building. Restart the development server, or rebuild the production app, after changing rewrite configuration.
- Signed upload/download URLs returned by the API are used unchanged. Main must configure storage/API `API_PUBLIC_URL` to a browser-reachable public origin; a remote browser cannot use a returned localhost URL. The web client does not rewrite signed capabilities or forward bearer tokens to storage.

## Verified source contracts

- `auth.ts`: OTP request `{phone}`, verify `{phone,code}`. `/me` returns user/memberships. Tokens stay in memory, refresh rotates through a single-flight request. `X-Membership-Id` accompanies authenticated requests; changing membership clears query caches. No client-made auth or local demo data.
- `core.ts`: paginated lists use `{data,nextCursor}`, not `{items,nextCursor}`. `api.list` normalizes this wire shape once.
- `registry.ts`: property CSV headers are `unitNo,block,floor,latitude,longitude,status`. Schedule patterns are nested discriminated unions. Vendor fields are `type`, `authorizationNumber`, datetime `validUntil`, required `documentId`, and optional `contractorId`. Route creation uses `{name,date,collectorId,vendorId,propertyIds}`.
- `storage.ts`: `/files/presign` accepts `{filename,contentType,size,purpose}`, returns `{fileId,uploadUrl}`; PUT bytes; POST `/files/:id/confirm`. Web uploads never claim CAMERA. Images and PDF are capped at 8 MiB.
- `operations.ts`: resolve/status transitions use `PATCH /complaints/:id` with `{status,note,photoId}`. Reopening uses `{note}`. Ratings support POST and PATCH; the server enforces verification, uniqueness and the edit window.
- `pickups.ts`: supervisor/ULB evidence detail is `GET /supervisor/pickups/:id`. Review posts `{decision,reason}`. Reassignment posts `{routeId,reason}` to `/supervisor/stops/:id/reassign`; the form asks for the uncollected stop ID and destination route ID.
- `billing.ts`: generate uses full-month `periodStart/periodEnd/dueDate`, not `period`. Issue DRAFT before paying. Payments use integer `amountPaise`, ISO `paidAt`, `reference`. Disputes use `{lineId,reason}`. Invoice line evidence is `evidence`.
- `compliance.ts`: document creation sends the confirmed upload ID in `storageKey`; document download returns a signed-URL JSON object, fetched separately without bearer headers. On-site logs use `/onsite-logs` and `{asset,capacityKg,date,inputKg,outputKg,downtime,photoId}`. Annual-return JSON is the extensionless record endpoint; generation takes `financialYearStart`.
- `analytics.ts`: dashboard `metrics` is a nested object of server-calculated metric records, not an array. Web flattens records without computing domain formulas. `trend` is `{weekStart,kgByStream}`. Null/not-measured values stay unmeasured.
- `reporting.ts`: contractor scorecards and ward metrics come from the dashboard response, not the registry lists. Exports support pickups, complaints, invoices, payments, certificates and accounts in CSV/XLSX/PDF. ULB escalation body is `{reason}`.

## Follow-up route alignment

The following previously missing routes are now present in backend source and match the web calls. This is source-level verification, not a claim that browser/API end-to-end tests ran.

- `GET /societies/:societyId/pickups` and `GET /ulb/:ulbId/pickups`: scoped, paginated evidence list.
- `GET /pickups/:id`: scoped society-admin pickup detail, streams and expiring photo URLs. Supervisor and ULB detail already use the implemented `/supervisor/pickups/:id` route.
- `GET /societies/:societyId/compliance/annual-returns`: list previously generated drafts.
- `GET /societies/:societyId/invoices/export.csv`: scoped accounts export for society admin.
- `GET /resident/properties`: the complaint form now loads a property selector from this scoped, paginated endpoint instead of requesting a manually entered ID.
- Vehicle management has no inspected API DTO yet. Supervisor reassignment is implemented, but uses IDs because no supervisor route lookup is available.

Resident/society complaint status filters were rechecked and are now implemented. The supervisor pickup endpoint intentionally shows its NEEDS_REVIEW queue; web exposes this as the review section, not as an all-status history.

## Verified outcomes

Executed on 2026-10-25 UTC with root-installed dependencies and `PATH=/tmp/bcode:$PATH`:

| Command | Result |
| --- | --- |
| `pnpm --filter @swachh/ui typecheck` | Passed. |
| `pnpm --filter @swachh/web typecheck` | Passed after fixing both MapLibre errors. |
| `pnpm exec vitest run --config apps/web/vitest.config.ts` | Passed: 4 files, 35 tests. Includes 20 geometry validation cases and 4 same-origin/default/override routing tests. |
| `pnpm exec eslint apps/web/src apps/web/next.config.ts apps/web/vitest.config.ts` | Passed, no diagnostics. |
| `pnpm --filter @swachh/web build` | Passed on final sources: compiled, typechecked, generated all 4 static pages, and completed build tracing. `/` first-load JavaScript: 251 kB. |

The initial typecheck reproduced TS2352 (unvalidated Row geometry cast) and TS2322 (null in a MapLibre expression). Geometry now narrows to validated Polygon/MultiPolygon coordinates with finite, in-range positions and closed rings. Invalid boundaries are omitted without repairing or inventing vertices. Missing coverage omits the property; a `has` expression displays grey rather than zero.

Next added `isolatedModules: true` to `apps/web/tsconfig.json`. The build retains one non-fatal warning: the Next ESLint plugin is absent from the root ESLint configuration. No root configuration was changed. Browser rendering, live proxy traffic, map tiles and storage uploads remain for main's browser acceptance run.

## Commands for root

```sh
pnpm --filter @swachh/ui typecheck
pnpm --filter @swachh/web typecheck
pnpm exec vitest run --config apps/web/vitest.config.ts
pnpm --filter @swachh/web build
NEXT_PUBLIC_DEMO_MODE=true pnpm --filter @swachh/web dev
```

Use `/?section=properties` etc. for operational routing and `/?demo=1` for the guided overlay after real login. Browser acceptance widths: 360, 390, 768 and 1280. Test authenticated downloads, expired access-token refresh, membership switching, empty database, disconnected API, uploads and all role workflows. Production demo buttons are intentionally absent even if NEXT_PUBLIC_DEMO_MODE is mistakenly enabled.

## Deliberate limits

- Reloading signs out because tokens are not persisted in browser storage. A first-party HttpOnly session proxy is a future deployment option, not an auth bypass.
- Collector capture remains in Expo; the web role is an honest handoff guide. Offline evidence needs supervisor approval before verified rating/billing.
- Source-provided metric definitions, API errors and user-entered records remain in their source language; controls and workflow guidance have English/Hindi translation keys.
- Map polygons/heat shading only use returned boundaries and server ward metrics; no invented boundaries or scores. Missing coordinates produce a real empty state.
- No installation or browser run was performed by this worker. Typecheck, unit tests, ESLint and production build were run successfully in the follow-up, as recorded above.
