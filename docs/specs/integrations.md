# Integrations (`integrations`) - specification

Master prompt section 15.3. The integration framework (INTG-001: ports, mock adapters, contract
tests and the inbound quarantine queue) and the communications adapters (INTG-011) are specified in
[platform.md](platform.md#integrations-framework-intg-001) and [comms.md](comms.md). This file holds
the adapters Phase 2 adds ([phase-2.md](../plans/phase-2.md), lane H) and, later, the others.
**Stub**: written with the Phase 2 plan to hold the headings and the rows; each lane H slice writes
its section before its code. Status per feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Section 15.3: connect Harbour to the partners a provider already uses, each behind a domain
interface with a contract test and a mock, so a tenant without the partner still has a working
product.

| Row | Feature (register) | Phase | Plan slices |
| --- | --- | --- | --- |
| INTG-006 | dm+d dataset sync and GTIN barcode lookup | 2 | 10 (reference tables and loader), 75 (download job) |
| INTG-007 | Identity and vetting: right-to-work IDSP, DBS e-bulk and Update Service, NMC register lookup | 2 | 77 |
| INTG-013 | E-signature and OCR adapters (optional DocuSign, camera scanning with OCR for paper MARs) | 2 | 79 |
| SCHED-008 | Payroll and pension exports (Xero Payroll first, Staffology, Sage, BrightPay; auto-enrolment flags) | 2 | 76 |
| WORK-006 | SCORM and xAPI e-learning player and LMS integration (the LMS imports) | 2 | 78 |

Later phases (register): INTG-002 to INTG-005, INTG-008 and INTG-010 (Phase 5), INTG-009 (Phase 4),
INTG-012 (Phase 3); the pharmacy interface MEDS-010 (Phase 5).

## 2. Schema

To be written by each slice. Connections per tenant use `integration_connection`; credentials stay
in the secret store (section 15.3 rules).

## 3. Permissions

To be written by each slice. Choosing a provider for a tenant is a tenant setting
([platform.md](platform.md)).

## 4. Rules that are easy to get wrong

Section 15.3 rules, for every adapter:

- an adapter behind a domain interface, with a contract test and a mock;
- credentials per tenant in the secret store;
- inbound data validated against Zod schemas and quarantined on failure, with a visible queue;
- integration health on the operator console.

Section 15.3 sets the dm+d sync as monthly; section 12.3 says approved timesheets go to payroll by
API or file, with auto-enrolment flags (`auto_enrolment.earnings_trigger`).

## 5. API and events

To be written by each slice.

## 6. Offline behaviour

The device holds the dm+d subset for its assigned people's medicines (section 17.1). Scanning a
paper MAR chart needs a connection: the phone takes the photograph and the server reads it with an
allowlisted engine in europe-west2 (ADR-0095 changes the earlier "OCR on the phone camera"); the
phone keeps nothing it read.

## 7. Clinical safety

dm+d data out of date or loaded wrongly is HZ-113; scanned or imported medicines stay "not yet
checked" until a second competent user checks them (HZ-005).

## 8. Data protection

A third-party service that receives personal data joins the
[sub-processor register](../compliance/sub-processors.md) and the DPIA (section 20 rule 8). Which
Phase 2 partners count as sub-processors is a DPO decision (H-520).

## 9. Acceptance criteria and tests

To be written by each slice: the port's contract tests pass against the mock and the real adapter.

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0013, ADR-0080, ADR-0094,
ADR-0095, ADR-0097) and the human actions in [human-actions.md](../plans/human-actions.md) (H-510,
H-511, H-518 to H-523, H-532, H-540).

## 11. E-signature and OCR adapters (slice 79, INTG-013, ADR-0095)

Two ports, each with a mock and a contract test (`apps/api/src/integrations/esign-ocr.test.ts`).
Domain rules: `packages/domain/src/integrations/esign-ocr.ts`. Schema: migration 0133
(`packages/db/src/schema/esign-ocr.ts`). API: `apps/api/src/routes/esign-ocr.ts`.

### 11.1 E-signature (`documents.signature`)

1. A member with `platform.document.manage` asks a named, active member to sign the **current
   version** of an **organisation document** (category `organisation_document`; its SHA-256 must
   match). A staff HR document, a logo and a person's document are refused (not found); a person's a person receiving care, or their representative, signs with the existing typed-name
   flow and a recorded capacity.
2. **In Harbour** (provider `in_app`, every organisation's default): only the member named signs,
   only while the request is open, only the exact bytes asked for (the hash they read must match
   the request and the current version), and only with a second factor used within the step-up
   window (ADR-0072). The typed-name `document_signature` row and the request's evidence (the
   signature, the time, that step-up was met) are written in one transaction. Someone else's
   request answers "not found".
3. **DocuSign** (provider `docusign`) only when the organisation chose it in
   `integration_connection` (port `documents.signature`) and the adapter is on (`DOCUSIGN`; today a
   no-network mock, refused in production until H-540). The envelope carries the document, its
   hash, a generic subject ("A document to sign") and the signer's name and the email they sign
   in with, nothing else. A send that fails or throws marks the request failed. Refreshing a request asks the provider where it stands: declined and voided close it; a
   completed envelope's signed copy is stored as a **new version** of the document through the
   storage port (malware scan first: an infected copy is never stored; the original's retention
   class), stored once however often it is refreshed, and only a copy that scanned clean marks the
   request signed (`envelopeTransition`). Cancelling checks the version first, then voids the
   envelope with a fixed reason, never the member's words.
4. A finished request (signed, declined, cancelled, failed) never changes, and its document, hash,
   signer and provider never change (database trigger).

### 11.2 OCR of scanned MAR charts (`documents.ocr`)

5. **Engines**: `OCR_ENGINES` lists those allowed and the only location each may run in:
   `google_document_ai` in `europe-west2` (Document AI, under the Google Cloud sub-processor entry,
   ADR-0098; the adapter waits for H-1262) and `mock` locally. Configuration refuses any other, the
   database refuses an extraction naming any other (`ocr_extraction_engine`), and production
   refuses the mock. With none configured, scanning answers "switched off".
6. OCR is switched on per organisation: `integration_connection` with port `documents.ocr` and
   the configured engine as provider, after the organisation's DPIA covers it (H-548, H-1261);
   otherwise scanning answers "switched off". `OCR_ENGINE` is `none` unless set; the mock reads
   nothing from an image without test instructions.
7. A member with `medicines.record.manage` that reaches the person uploads the photograph (capped
   before it is read, like every upload), optionally with an `Idempotency-Key` (a UUID): a retry
   with the same key returns the first scan. It is stored first as the person's document
   (`person_document`: malware scan, care record retention); an image that does not scan clean is
   never read. The allowlist is checked again just before the engine is called. A result with a
   line outside 0 to 199 or a part Harbour does not know is refused whole (`unreadable`), never
   coerced.
8. Every value read is **unconfirmed**. A person confirms it as read, corrects it, or rejects it;
   confirming or correcting also decides **which chart line and which part** it is (the engine's
   are a proposal; `decidedLine`, `decidedLabel`). A text longer than a value holds is cut and
   marked truncated: corrected or rejected, never confirmed. A person can add a value the scan
   missed (`addedByPerson`). The engine's confidence is never sent to the screen: only a "check
   carefully" flag below `OCR_LOW_CONFIDENCE`. A decided value and the text as read never change.
9. **Release** (`releaseRefusal`) needs: every value decided; no part standing twice on one line
   (never joined); no line's values without its medicine (never dropped); at least one medicine
   line; the person's own count of medicine lines on the paper chart (typed, never prefilled)
   matching; every medicine line marked `active` or `stopped` on the chart (`cannot_tell` blocks
   release until the prescriber or pharmacy is asked); the name and date of birth on the chart
   confirmed as the person's (HZ-130); the chart's period, and that it is the chart in use now.
   It emits `integrations.ocr_mar_released` with ids and a line count only.
10. The medicines module (slice 51) reads `GET /v1/ocr-extractions/{id}/medicine-lines`: lines in
    force only, each part with how it was decided (confirmed, corrected, added by a person) or
    null; notes kept with their line and chart notes kept apart; stopped lines listed by number;
    the photograph's id; who decided values and who released, none of whom may be the second
    checker (slice 51). Each line is origin `import`, **not yet checked**, and **held** ("do not
    give") until its second check whatever the organisation's usual rule (`marEntryStatus`;
    HZ-005, H-548). OCR never writes a MAR entry and never chooses a dm+d product, a dose unit or
    a schedule.
11. A scan can be discarded instead; nothing it read is then used. The image stays the person's
    document.
12. Screen rules for the later web and mobile slices (H-1266; HZ-005 controls): the photograph
    beside every value; no bulk confirm; the correction box never prefilled; the engine's number
    never shown; a released scan shown as "Released: waiting to be added to the MAR" until slice
    51 has transcribed it.

### 11.3 Permissions

No new permissions (so no role backfill): `platform.document.manage` asks for, cancels and
refreshes signature requests; any member signs requests naming them (step-up);
`integrations.connection.manage` chooses the provider; `medicines.record.manage`, where it reaches
the person, scans, decides, releases and reads lines.

### 11.4 API

| Route | Purpose |
| --- | --- |
| `POST /v1/documents/{id}/signature-requests` | Ask a member to sign (sends the envelope through DocuSign when chosen) |
| `GET /v1/documents/{id}/signature-requests` | A document's requests |
| `GET /v1/me/signature-requests` | What I am asked to sign |
| `POST /v1/signature-requests/{id}/sign` | Sign in Harbour (step-up) |
| `POST /v1/signature-requests/{id}/cancel` | Cancel with a reason |
| `POST /v1/signature-requests/{id}/refresh` | Ask DocuSign where it stands; store a clean signed copy |
| `POST /v1/people/{id}/mar-scans` | Scan a paper MAR chart (the body is the photograph) |
| `GET /v1/people/{id}/ocr-extractions` | A person's scans |
| `GET /v1/ocr-extractions/{id}` | A scan with each value (view audited) |
| `POST /v1/ocr-extractions/{id}/fields/{fieldId}/decision` | Confirm, correct or reject a value, deciding its line and part |
| `POST /v1/ocr-extractions/{id}/fields` | Add a value the scan missed |
| `POST /v1/ocr-extractions/{id}/release` | Release a fully accounted-for scan (count, line statuses, person, period) |
| `POST /v1/ocr-extractions/{id}/discard` | Discard a scan |
| `GET /v1/ocr-extractions/{id}/medicine-lines` | A released scan's lines, for slice 51 |

Audit events: `platform.signature.requested`, `.sent`, `.failed`, `.signed`, `.cancelled`,
`.refreshed`; `integrations.ocr.blocked`, `.read`, `.viewed`, `.decided`, `.added`, `.released`,
`.discarded`, `.lines_read`. None carries a value read or typed.

### 11.5 Data protection and retention

Signature requests: who is asked to sign which organisation document, and how it was signed;
retained with the document (`as_subject`). OCR extractions and fields: health data about the
person, in the person's scope (history included), retained as the care record. Records of
processing, data standards, retention, the sub-processor register and the DPIA (R25) are updated
with this slice.

### 11.6 Tests

Domain (`esign-ocr.test.ts`), adapter contracts (`apps/api/src/integrations/esign-ocr.test.ts`),
database (`packages/db/test/esign-ocr.test.ts`) and API (`apps/api/test/esign-ocr.test.ts`).
Web and mobile screens for scanning and signing are later slices (H-1266).
