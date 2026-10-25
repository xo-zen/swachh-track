# Swachh-Track Decisions

## Locked architecture

- Modular monolith: Fastify API, Prisma/PostgreSQL, one BullMQ worker, private S3 storage; Next.js and Expo clients share strict contracts and pure domain rules.
- The workspace was empty. Node 22 is present, but pnpm, Docker, PostgreSQL and Redis were not preinstalled. A temporary pnpm installation is used; Compose remains the supported reproducible infrastructure path.
- Every operational record carries `ulbId`; society and resident restrictions are enforced inside scoped data access. Membership selection is explicit, never inferred from an arbitrary client tenant ID.
- Money is integer INR paise. Weights are decimal kg with at most three decimals. Dates are UTC; UI and documents use Asia/Kolkata.
- Pickup client UUID is immutable. Retrying an identical batch idempotency key returns its stored response; reusing a key with different content returns 409. A duplicate UUID submitted under another key returns 409 with its original result.
- Upload reservations precede event verification. The server downloads private uploads, validates/re-encodes them and stores normalized hashes; the event cannot provide trusted hashes or storage paths.
- Offline capture and poor GPS accuracy are soft review flags. Out-of-geofence, invalid QR, absent weights and duplicate normalized images are hard failures. Accepted exceptions never masquerade as verified kg.
- QR tokens use base64url-encoded `propertyId.signature`; the signature includes a configured secret version. Store token hashes, not reusable tokens. Numeric fallback resolves a property only within the collector's assigned cached route.
- The requirement for a camera declaration does not prove image origin or defeat a compromised device. Neither QR, GPS nor photos provide perfect anti-spoofing.
- The fixed development OTP is enabled only when both NODE_ENV=development and DEMO_MODE=true. Production fails closed without configured secrets/provider. Demo identities are fictional email aliases mapped to synthetic phone identities.
- Rule 5/6 thresholds and three-year certificate defaults implement the supplied product specification, not an independently verified legal opinion. ULB determination and review are required. The application records externally issued certificates and never issues one itself.
- Feature flags default off for billing, compliance v2, WhatsApp and Swachhata. Seeded demo tenant can explicitly enable billing/compliance to demonstrate them.
- Routes are manually ordered. No hardware, government submission, production messaging onboarding, payment gateway or route optimisation is claimed.

## Verification policy clarification

The demo asks an offline pickup to immediately become VERIFIED, while the verification specification requires offline capture to be flagged. The stronger rule wins: an offline capture becomes NEEDS_REVIEW; an authorised supervisor can approve it with a reason before resident rating and billing.

## Acceptance reporting

A passing unit test does not establish Android hardware behaviour, PostGIS operation, provider delivery or production readiness. BUILD_LEDGER.md records executed commands and limitations; no milestone is complete solely because files exist.
