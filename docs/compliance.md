# Compliance And Evidence

## What This Module Does Not Certify

Swachh-Track records operational evidence and prepares review material. It does **not** determine legal compliance, register a society with CPCB, issue an EBWGR certificate, submit a government return, verify a government registry, or certify recycling. The ULB and appropriate professional reviewers must determine applicable obligations and validate source documents.

The Rule 5/Rule 6 labels, thresholds and certificate defaults implement the supplied product specification. They were not independently checked against current law, local notifications or an authorized legal opinion. Do not present this repository as legally verified, DPDP-certified, government-approved, or ready for statutory filing.

`compliance_v2` is enabled for the fictional demo tenant and otherwise off unless explicitly configured. Demo registration, authorizations, certificates, map boundaries and photos are synthetic examples, not official records.

## Eligibility And Registration

Implemented in `packages/domain/src/compliance.ts` and `apps/api/src/compliance.ts`:

| Rule                       | Current calculation                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Indicative BWG             | Any of floor area >= 20,000 sq m, water >= 40,000 litres/day, or waste >= 100 kg/day |
| RWA/gated-community duties | Area strictly > 5,000 sq m and RWA/community input true                              |
| Classification             | `BWG`, otherwise `RWA_DUTIES_ONLY`, otherwise `BELOW_THRESHOLD`                      |
| Flat count                 | Accepted input; no invented flat-count eligibility threshold                         |

Area is the supplied floor-area proxy, not a surveyed or legally resolved site-area measurement. Eligibility updates persist area/water/waste as self-reported values. The summary recomputes flats from active properties and assumes the society is an RWA/gated community; the submitted `flats` and RWA boolean are not independently persisted as authoritative registration facts.

Registration is implemented, not omitted: the summary displays `Society.registration`, and web/API allow recording `cpcbStatus` (`NOT_STARTED|PENDING|REGISTERED`), number, registration date, renewal date and a same-society document ID. Renewal cannot precede registration. `REGISTERED` is a user's recorded status, not a successful CPCB API lookup. The fictional seed contains partial `PENDING` examples rather than completed official registration packs.

## Document And Certificate Registers

- Upload real bytes through reservation, PUT and confirmation before creating a document. Document metadata includes type, number, issuer, dates and an owned confirmed upload reference.
- Documents remain private and are read through authorized five-minute signed URLs. Images are normalized; PDF receives envelope/size checks only. Malware scanning reports `NOT_CONFIGURED`.
- Only ULB/super-admin roles can record externally issued certificates. Society admins can view the ledger but cannot issue or record a certificate through that route.
- Certificate fields include number, stream, positive kg, issue/expiry dates, source document and recording actor. Default validity is three calendar years (tenant-configurable), with leap-day handling. This is a configurable application default, not a verified statutory rule.
- Validity is inclusive through the local expiry day; coverage excludes out-of-date/revoked records. Domain expiry thresholds are 90, 30 and 7 days, plus expired status. Delivery of reminders depends on the worker; external push/message delivery is not configured.
- Routes require documented, in-date vendor/contractor authorization. Handovers require an active authorized vendor on the handover date and a receipt document. These are stored-record checks, not independent licensing verification.

## Provenance And Quantities

| Label            | Meaning in this build                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `VERIFIED`       | Passed implemented evidence checks or an authorized review; not infallible truth or legal certification |
| `SELF_REPORTED`  | Entered quantity/status without the stronger verified chain, including onsite processing                |
| `ESTIMATED`      | Computed projection from recorded inputs, not a measured annual total                                   |
| `NOT_MEASURED`   | Required evidence/denominator is absent; do not replace with zero or 100%                               |
| `DEMO_SYNTHETIC` | Fictional fixture provenance; must not be represented as actual civic performance                       |

Normal collected kg derives from verified non-exception pickups. Offline events are `NEEDS_REVIEW` until reasoned supervisor approval. Hard failures cannot be approved, and accepted exceptions never contribute verified kg or verified-stop coverage.

Handovers start self-reported. ULB/super-admin can mark a handover verified with a reason; that does not prove downstream processing. Onsite logs record asset, capacity, date, input/output kg, downtime and photo. Output cannot exceed input, and input cannot exceed capacity. No onsite approval endpoint exists in this build: summary processing quantities remain `SELF_REPORTED`.

Annual obligations are per-stream projections from verified history and observed days, labeled `ESTIMATED`. The summary uses a rolling 30-day period by default; annual snapshots use the selected financial-year period. The pure helper supports a verified onsite-wet deduction, but the current API does not supply one. Do not deduct self-reported composting as a verified exemption.

Certificate coverage compares in-date documented certificate kg with the calculated obligation, by stream. Coverage may exceed 100%; a zero obligation returns null. Empty verified history also returns **null coverage**, not measured zero or full compliance, while retaining a scoped `query:verified-pickups:<ulbId>:<societyId>:<from>:<to>` reference in `obligationSourceIds`. This is implemented in `apps/api/src/compliance.ts`; `apps/api/tests/api.integration.test.ts` verifies both the empty-history summary and annual draft. Gap totals sum per-stream deficits, so a wet surplus cannot hide a dry deficit. Stored certificate evidence is not an external authenticity check. Review completeness of the observation period before relying on estimates; partial history is not a complete annual waste record.

Mass balance compares collected vs handed-over, handed-over vs processed, and collected vs processed. Absolute variance strictly above 5% requires review. Zero denominators produce null; nonzero downstream quantities without upstream quantities still flag anomalies. Recycling rate requires verified quantities, receipt evidence and a plausible quantity chain. Since current onsite output is self-reported, that route cannot establish a verified recycling percentage. The `MassBalance` database model is not populated by a materialization scheduler.

## Returns And Inspection Pack

`POST /societies/:societyId/compliance/annual-return` takes `financialYearStart` and `Idempotency-Key`. A year of 2026 means 2026-04-01 through 2027-03-31 IST. The API stores one draft snapshot per society/year; a duplicate with a new key conflicts rather than replacing it. JSON and server-rendered PDF downloads are implemented and labeled **DRAFT - for ULB/CA review**. There is no submit, certify or amendment executor.

The inspection PDF includes registration, document/authorization register, vendors, certificate ledger, verified pickup register for the preceding 365 days, onsite logs, invoices and gaps/variance. It **merges available stored original PDF pages and normalized JPEG evidence, plus generated invoice PDFs**, with labels and global page numbers. `apps/api/src/compliance.ts` reads the scoped vault documents and renders invoice detail; `inspectionPdf` in `apps/api/src/pdf.ts` combines them. Originals remain in the private vault too. Missing document references remain explicit in the register; this is not proof that every legally required document exists or is authentic. An undecodable original produces **422 `DOCUMENT_MERGE_FAILED`**, not a silently partial pack.

`reportPdf` in `apps/api/src/pdf.ts` renders bounded A4 pages rather than an oversized section. `apps/api/tests/pdf.test.ts` parses actual page text to verify all **4,100 rows**, a huge **3,000-ID JSON** line and its final text survive pagination. It also checks merged original PDF text/page size, JPEG bytes, page numbers and rejection of undecodable evidence. These are renderer/merge regression tests, not statutory review or malware scanning.

On **2026-10-25**, the **262-test / 0-skip** core run included **26 real PostgreSQL integration tests**. The separate browser suite in `tests/web.e2e.mjs` downloaded annual-draft and inspection PDFs against production-built Next with a development/demo API; [outputs/web-e2e.json](../outputs/web-e2e.json) records 10/10 scenarios at **04:37:17.015 UTC**. The browser checks PDF download bytes; content/merge assertions are in the separate PDF tests. Samples are `outputs/example-annual-return-draft.pdf` and `outputs/example-inspection-pack.pdf`.

Use a financial year containing actual fixture/history data for a demonstration. Empty-history summary/annual-draft behavior is tested; missing-document completeness, partial-year and revised-data review still need explicit acceptance. Generating a draft or merged pack is not evidence that a complete statutory return exists. M8 remains partial, with no public deployment or production certification.

## Billing, Retention And Release Review

Fees are society-configured, stored in integer paise with source/date metadata. The seed tariff is fictional. Monthly invoices record service fees, verified-stop/weight charges, missed-stop deductions and reasoned adjustments. A billable missed stop has neither a verified collection nor an accepted exception; dashboard missed-stop metrics use a different operational definition. Manual payment is bookkeeping, not payment processing or tax compliance.

Photo/audit/invoice retention settings and privacy requests are persisted, but no scheduled destructive deletion, legal-hold system, subject-export bundle or erasure executor is implemented. Default seed retention values are product configuration, not independently verified legal retention advice. See [security](security.md).

Before a real pilot, an accountable reviewer must confirm applicable law and tariff sources, supplier/certificate authenticity, actual site coordinates, consent/privacy notices, retention/legal holds, required return format, original-document inclusion, evidence gaps and provider onboarding. Keep the recorded provenance and approval history visible in every external claim.
