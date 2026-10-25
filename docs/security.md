# Security

## Status And Trust Model

This is a development/pilot implementation, not a completed security assessment. Passing tests establish specific assertions, not production readiness, legal compliance, resistance to a compromised phone, or a guarantee against fraud. Use synthetic data until deployment, privacy and physical-device gates are completed.

Untrusted inputs include web/mobile requests, GPS/time/weight declarations, uploaded files, QR possession, webhook bodies and user-authored spreadsheet content. The API, signing keys, database administration, object-store administration and supervisor/ULB decisions are trusted boundaries. A malicious administrator or rooted collector device is not neutralized by this build.

## Implemented Controls

| Area               | Current control                                                                                                          | Residual boundary                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Authentication     | HMAC-hashed OTP/refresh values, bounded OTP attempts, short access JWT, refresh rotation and reuse-family revocation     | Production OTP provider absent; no immediate per-token access revocation |
| Authorization      | Active user/membership lookup, role gates, ULB/society/resident/contractor predicates                                    | Application scoping, not database RLS; new queries need the same guards  |
| Database integrity | Deferred tenant-reference checks, positive money/kg checks, verified-stop uniqueness, append-only audit/history triggers | DBA can bypass/change controls; no external tamper-evident audit archive |
| Uploads            | Owned reservations, private five-minute capabilities, real-byte decoding, size/pixel limits, normalized image hashing    | PDF malware scanning absent; signed URLs grant temporary bearer access   |
| Collection         | Assigned route/date, registered device, signed QR/hash, geofence, duplicate-image rules and review                       | No camera/GPS/scale hardware attestation                                 |
| API surface        | Strict request objects, error envelope, Helmet, CORS allowlist, request limits                                           | Process-local rate limiting; proxy topology must be designed explicitly  |
| Exports            | Tenant/role checks, row cap, audited downloads and CSV formula neutralization                                            | Downloaded evidence can be copied outside application control            |
| Mobile persistence | SecureStore tokens/device ID; scoped SQLite queue and durable evidence checkpoints                                       | SQLite/photos are sandboxed, not application-encrypted                   |

Primary sources: `apps/api/src/{app,auth,core,storage,pickups}.ts`, Prisma migrations 002/003, and `apps/collector/src/{schema,storage,media,sync}.ts`.

## Secrets And Demo Isolation

- `.env.example` contains placeholders, not safe defaults. Generate independent cryptographically random `JWT_SECRET` and `QR_SECRET`, at least 32 characters each. Current config checks length, not placeholder quality. Generate separate database/object-store credentials and never commit them.
- Fixed OTP `123456` and demo email aliases require both `NODE_ENV=development` and `DEMO_MODE=true`. Production rejects demo mode; non-demo OTP returns 503 until a provider is actually implemented/configured.
- The five demo accounts are public synthetic identities, not protected pilot accounts. Do not expose a demo-enabled API with real data. `NEXT_PUBLIC_DEMO_MODE` only controls development web buttons; it is not the API's authorization switch.
- Changing JWT secret invalidates existing JWTs, hashed refresh/OTP values and local signed storage capabilities. Plan coordinated reauthentication. Changing QR key/version invalidates existing property tokens until hashes/sheets are regenerated and route caches refreshed; unchanged key/version is not a real QR rotation.
- Compose forces development mode, uses a development Next server and MinIO root credentials from `.env`. It is not a production-hardening recipe. Never reuse CI's explicitly test-only database password or keys in a deployment.

## Session And Device Limits

Access JWTs expire after 15 minutes. Refresh tokens expire after 30 days, rotate on use, and revoke their family on detected reuse. Logout revokes that refresh family only: an existing access token can remain usable for **up to 15 minutes**, unless its user/membership is made inactive. The API rereads those active records per authenticated request.

Web tokens stay in memory, not localStorage/cookies; full reload requires login. This reduces persistent token exposure but does not prevent malicious page JavaScript from acting as the current user. There is no implemented HttpOnly session proxy. Expo stores tokens and the stable device ID in SecureStore. Sign-out preserves the device ID, route cache, queues and images; re-login to the same scope restores access.

At most two active devices may bind to one collector. A seeded demo device already occupies one slot. Supervisor/ULB revocation is checked by subsequent collection validation, but does not remotely erase the phone or provide hardware identity attestation. Repeated reinstall/rehearsal may require revoking a stale demo binding rather than bypassing the device limit.

## Rate Limits And Proxying

Fastify's global limit is 300 requests/minute per default IP key. OTP request adds 10/15 minutes and verification 30/15 minutes. These IP buckets are **single-process memory**, not Redis-backed distributed limits. OTP's 60-second cooldown, five requests/phone/hour and five verification attempts are persisted with transaction serialization.

`trustProxy` is false. Behind a reverse proxy, requests may share the proxy's apparent IP and rate-limit each other. Do not enable arbitrary forwarded-header trust as a shortcut; configure a vetted proxy chain and shared limits before horizontal scaling. CORS is an allowed-origin browser control, not authentication or protection against direct API clients.

## What Evidence Can And Cannot Prove

The app has no gallery evidence picker and requests live camera/foreground GPS, but `captureSource:"CAMERA"` is a **client declaration**. It does not prove image origin. The collector upload contract contains no independent photo timestamp; the API uses the event time when constructing trusted-rule input. Photo-time rule unit tests do not create hardware timestamp attestation in the deployed path.

Assigned cached routes include signed QR tokens. Numeric fallback submits the selected stop's cached token. QR signature validation proves token validity, not a fresh physical scan or strong presence. GPS can be spoofed on compromised devices; weights are manually entered and there is no Bluetooth scale integration. Do not describe these controls as spoof-proof.

Defaults are a 75 m hard geofence and >50 m GPS-accuracy review threshold. Offline capture always requires review; capture/receipt delay cannot distinguish network delay from clock error. Otherwise-clean captures have a 5% random-review branch. Reused normalized hashes at the same property within the prior 24 server-receive hours, or duplicate images within an event, are rejected. Cropped/altered images may evade exact-hash detection; no perceptual duplicate detector or AI contamination classifier is implemented.

Supervisors must supply reasons; hard failures cannot be approved into verified evidence. Accepted exceptions are not verified collections. Reviews are accountable human decisions, not proof that all submitted declarations were independently measured.

## File And Data Handling

Uploads are capped at 8 MiB. Image confirmation decodes/reencodes with Sharp, strips EXIF and normalizes pixels before hashing. PDF confirmation checks size and PDF envelope, not active content, authenticity or malware. `scanStatus:NOT_CONFIGURED` must remain visible; deploy a scanner/quarantine policy before accepting untrusted production documents.

Local storage is explicitly forbidden in production. For S3, verify private bucket/IAM policy, TLS, browser CORS, encryption, access logs and expiring signed reads/writes. The initializer creates/checks a bucket, not a complete policy. S3/MinIO interoperability and post-confirmation overwrite behavior have not been runtime-tested here. Share signed URLs only with intended viewers; access to an issued URL is not rechecked against current membership until it expires.

The logger redacts configured authorization/cookie and selected body paths; do not infer comprehensive PII redaction. Request URLs can contain signed storage capabilities. Review/redact URLs and request/response logging at API, proxy, storage and error-monitoring layers before deployment. Never log OTPs, refresh/access tokens, QR secrets, full signed URLs or household photos in diagnostics.

SQLite and JPEG evidence use Android's app sandbox/device encryption, not SQLCipher or independent application-level photo encryption. Android backup is disabled in app configuration. Use managed lock-screen/encryption/remote-loss policy. No automatic durable-photo cleanup exists, even after acknowledgement; disk exhaustion is an outstanding physical acceptance scenario. Never uninstall or clear app data with unsynced evidence.

Retention settings do not execute deletion. `POST /me/privacy-requests` persists an export/erasure request for review only. There is no automated subject-data export, destructive erasure, legal-hold enforcement or scheduled evidence purge. Do not tell a resident that data has been deleted because a request returned 202.

## External Integrations

SMS, production email, WhatsApp, FCM and government adapters are not configured. Development email is a logger, not delivery. Signed webhook validation uses HMAC-SHA256 over the raw body; valid signatures still produce `NOT_CONFIGURED` and retain a local payload. There is no production replay/timestamp protocol or verified provider event-consumption contract to rely on yet.

Map tiles come from OpenStreetMap over the network; review tile usage terms and third-party request/privacy implications for a deployment. No live collector location broadcasting is implemented.

## Before A Real Pilot

1. Separate synthetic demo/test data and credentials from pilot infrastructure; implement and test non-demo OTP before disabling demo access.
2. Add HTTPS, least-privilege database/storage accounts, private bucket policies, validated CORS and explicit proxy/shared-rate-limit configuration.
3. Complete S3 upload/confirmation/download tests, scanner/quarantine handling, log redaction and a dependency/security review.
4. Test native Android camera/GPS, permissions, force-stop/reboot, token rotation, device revocation, storage exhaustion and membership isolation on real hardware.
5. Approve privacy notices, consent handling, retention/legal holds and an accountable privacy-request process before implementing destructive cleanup.
6. Implement and rehearse backups/restores for PostgreSQL and evidence objects; measure worker health, retries, queue age, capacity and alerting. PostgreSQL readiness alone is insufficient.
7. Resolve browser/worker acceptance, throughput and original-document packaging gaps in [acceptance](acceptance.md). Obtain legal/ULB review separately from technical acceptance.

Report suspected credential exposure or cross-tenant access privately to the deployment owner; do not attach real resident data or secrets to a public issue. This repository does not define an operational incident-response team or support SLA.
