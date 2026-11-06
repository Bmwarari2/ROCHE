# E-signature and OCR adapters

Branch `feat/integrations-esign-ocr` (Phase 2 slice 79; INTG-013; ADR-0095), cut from main after
the Google Cloud move.

## What changed

- **ADR-0095**: signing in Harbour by default; DocuSign optional and off; OCR on the server with an
  engine allowlist in europe-west2 (Document AI, for when the adapter is built); every OCR value
  unconfirmed until a person decides it (HZ-005).
- **Domain** (`packages/domain/src/integrations/esign-ocr.ts`): the signature and OCR ports, the
  engine allowlist, the in-app signing rules, envelope transitions, the confirm-correct-reject
  rules, release, and scanned MAR lines that arrive not yet checked with a second check required.
- **Migration 0133**: `signature_request`, `ocr_extraction`, `ocr_field`, with forced row-level
  security, the person scope on OCR rows and their history, guards that keep the text as read and a
  decided value fixed and a finished record finished, the engine allowlist as a constraint, the
  export catalogue and the sample data removal list.
- **API**: signature requests (ask, list, mine, sign with step-up, cancel, refresh from DocuSign
  storing a clean signed copy as a new version), and MAR scans (scan, list, view, decide each
  value, release with `integrations.ocr_mar_released`, discard, medicine lines for slice 51).
  Mock adapters with contract tests; `OCR_ENGINE` and `DOCUSIGN` settings, both mocks refused in
  production.
- **Docs**: integrations.md section 11; hazard log HZ-005 controls and tests; records of
  processing, data standards, retention, the sub-processor register, DPIA R25 and the
  medical-device boundary.

## Reviews

- Security review (round 1): one high (a signature request could name a staff HR document and a
  DocuSign copy come back readable by all) fixed by allowing organisation documents only and
  keeping the original's class and retention; a returned copy is scanned before it is stored and
  stored once; stale cancels void nothing and send a fixed reason; a failed send marks the request
  failed; a composite foreign key binds the signature to the tenant and document; the scan upload
  is capped; uploads take an idempotency key; the allowlist is checked at each call; a non-signer
  learns nothing about a request.
- Clinical safety review (round 1): a person now decides each value's chart line and part; release
  refuses a part twice on a line, values without their medicine, a count on the paper that differs,
  a line not marked in force or stopped, an unconfirmed person (HZ-130) and an old chart; a
  truncated text cannot be confirmed; a missed value can be added; the engine's confidence is only
  a flag; OCR is off unless set and per organisation, and the mock invents nothing; imported and
  scanned MAR entries are held until their second check whatever the organisation's rule.
- Recommended answers for H-1260 to H-1269 are in `docs/plans/recommended-answers.md`.

## Human actions

H-1260 to H-1269 in `docs/plans/human-actions.md`.
