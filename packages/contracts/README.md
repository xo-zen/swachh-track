# @swachh/contracts

Strict Zod **3.25.28** schemas and a small fetch client. Import from
`@swachh/contracts`; package export is `./src/index.ts`. No Node-only imports.

`pickupSchema` implements the locked camelCase event shape with mandatory
`client_uuid`. `PickupRequest` is raw schema input; `PickupInput` is parsed output.
`streams` defaults to `[]` only so exception-only events can omit it. Collections
need positive three-decimal kg, distinct streams, scale/bin photos per stream,
a doorstep photo and contamination notes when flagged. Exceptions always require
a note/photo. Verification status is never a client input.

`batchSchema` is exactly `{ events: PickupRequest[] }`, length 1 through 500.
It does not deduplicate UUIDs: the API owns transactional idempotency and conflict
responses. Unknown fields are rejected, including nested fields and client hashes.

Other exported schemas cover enums (`ROLES`, `STREAMS`, `SEGREGATIONS`,
`EXCEPTION_CODES`), auth OTP/refresh, device registration, properties, residents,
schedules, route assignment, supervisor review, stop transitions, ratings,
complaints/transitions/reopen/configurable categories, eligibility, vendors,
documents, certificates, handover, processing logs, annual-return requests,
invoice generation, payments/disputes, notification preferences, photo
presign/confirm, list queries and the standard error envelope. Tenant/ownership
identifiers are server/context-owned except resource references explicitly needed
by the request. A valid UUID is not an authorization check.

```ts
import { createApiClient, ApiError, batchSchema } from '@swachh/contracts';

const api = createApiClient({
  baseUrl: 'https://api.example.test/api/v1',
  getAccessToken: () => sessionAccessToken,
});
const batch = batchSchema.parse(queuedBatch);
await api.request('/collector/pickups/batch', {
  method: 'POST', body: batch, idempotencyKey: stableBatchKey,
  // schema: responseSchema, optional runtime response validation
});
```

`createApiClient({ baseUrl, getAccessToken?, fetch? })` returns
`request<T = unknown>(path, { method?, body?, headers?, idempotencyKey?, signal?, schema? })`.
Use a response Zod schema to get runtime-checked inferred results. Without a
schema, an explicit generic type is only a TypeScript assertion. No automatic
retry or token refresh is hidden in the client. Paths must be origin-relative;
redirects are blocked to avoid forwarding bearer tokens unexpectedly.

`ApiError` contains HTTP `status`, `code`, `message`, `details` and `requestId`.
It preserves the server envelope, normalizes non-JSON HTTP errors, and rejects
invalid JSON success bodies. Network and abort errors remain native fetch errors.
204 responses return `undefined`. Error-envelope request IDs are optional for
offline/development/gateway errors; production handlers should always set them.

Tests: `pnpm exec vitest run packages/contracts`; typecheck:
`pnpm --filter @swachh/contracts typecheck`. Actual HTTP authorization, server
refresh-token rotation and photo processing are intentionally outside this package.
