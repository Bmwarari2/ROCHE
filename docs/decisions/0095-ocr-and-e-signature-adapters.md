---
status: proposed
date: 2026-11-01
decision-makers: Claude Code (lead engineer), taking the Phase 2 plan's default; the CSO and the DPO accept or change it (H-1260, H-1261)
consulted: master prompt sections 5.1, 5.2, 5.3, 9.1 (documents and e-signature), 10 (medicines), 15.3 (integrations) and 20; docs/plans/phase-2.md (ADR table, slice 79); ADR-0098; docs/specs/integrations.md; docs/compliance/medical-device-boundary.md; H-540, H-548
informed: everyone working in this repository
---

# OCR and e-signature adapters: in-app signing by default, DocuSign optional, server-side OCR in europe-west2 that a person confirms value by value

## Context and problem statement

Slice 79 (INTG-013) adds two ports. An e-signature port: providers ask for a document to be
signed by a named member, and a few may want DocuSign (H-540). An OCR port: during a migration a
home photographs its paper MAR charts, and reading the text back saves typing (H-548). Both touch
personal data, and OCR touches medicines: a misread dose that reached a MAR unnoticed could harm
someone (HZ-005). Section 15.3 of integrations.md said OCR would run on the phone camera; the
Phase 2 plan moved it to the server, so an allowlisted engine in the UK region does it and the
phone keeps nothing.

## Decision drivers

- Safety first (HZ-005): OCR text is never a fact. Nothing it reads may fill a clinical field
  until a person confirms that value; a scanned medicine still needs its second check.
- Never a medical device: OCR transcribes; it never suggests a dose, a product or a schedule.
- UK residency (ADR-0098): personal data is processed in europe-west2 only.
- Configurable, never forked: every organisation gets a working product with no partner.
- A signature is evidence: who signed, what exactly (the bytes' hash), when, how they proved it
  was them.
- Everything stored goes through the storage port with a malware scan and a retention class.

## Considered options

1. In-app signing only; OCR on the phone (the original section 15.3 wording).
2. In-app signing by default with an optional DocuSign adapter; server-side OCR with an engine
   allowlist limited to europe-west2; every OCR value confirmed by a person (the plan default).
3. DocuSign for every signature; a third-party OCR service chosen per organisation.

## Decision outcome

Chosen option: 2.

### E-signature port (`documents.signature`)

- **In-app by default** (provider `in_app`). A signature request names a document, the hash of
  the version to sign and the member who signs. The member signs in Harbour, signed in, with a
  fresh second factor (step-up, ADR-0072), typing their name against the statement. The evidence
  row keeps the document hash, the signer, the time, the step-up method and the request; the
  existing `document_signature` row is written in the same transaction. Nothing leaves Harbour.
- **DocuSign** (provider `docusign`) only when an organisation asks and H-540 is done: an
  account, the DPA, the sub-processor register and the DPIA. It is off by default and built
  here as a contract-tested mock that makes no network calls. The envelope carries the document
  and the signer's work email only; the signed PDF that comes back is stored as a new version of
  the document through the storage port (malware scan, the document's retention class), and the
  request records the provider's envelope id. A completed envelope whose returned bytes fail the
  scan stays quarantined and the request is not marked signed.
- A request never signs on behalf of someone else, and a person receiving care never signs
  through DocuSign (their signatures stay the in-app typed-name flow with a recorded capacity).

### OCR port (`documents.ocr`)

- **Server-side**, by an engine on the allowlist, in europe-west2 only:
  `google_document_ai` (Document AI, processor location `europe-west2`, ADR-0098 project) for
  production, and `mock` for development and tests. An engine or a location not on the list is
  refused at configuration and again at every call. No other OCR service may receive images.
- The source image is stored first as a document (storage port, malware scan, the category's
  retention class); only a clean document is read. The engine receives the bytes and returns
  text with a confidence per line; Harbour keeps the text as **unconfirmed** fields.
- **Every value is unconfirmed until a person decides it**: confirm as read, correct it, or
  reject it. Confidence never confirms anything, however high, and is never shown as a score of
  safety. An extraction is released only when every field is decided.
- **Scanned MAR charts** (H-548): a released extraction becomes draft medicines for the
  medicines module (slice 51) through the outbox event `integrations.ocr.mar_released`, each line
  with origin `import`, the confirmed text only, and the rule that it arrives "not yet checked"
  and needs a second competent member's check before any dose is given (HZ-005). OCR never writes
  a MAR entry itself and never picks a dm+d product: the transcriber still chooses the product
  from dm+d in slice 51.

### Consequences

- Good: every organisation has a working signature and OCR with no partner; residency holds; a
  misread value cannot reach a clinical field unseen.
- Good: the ports, mocks and contract tests are ready for a real adapter when an organisation
  needs one.
- Bad: confirming each value is slower than accepting a page. That is the point (HZ-005), and the
  page shows the image beside each value to make it quick.
- Bad: the DocuSign adapter is a mock until H-540; turning it on needs code review of the real
  client against the same contract tests.

### Confirmation

- Domain tests: engine allowlist, every OCR field starting unconfirmed whatever its confidence,
  release only when every field is decided, MAR release lines all "not yet checked" with a second
  check required, signature evidence rules.
- Contract tests that every signature and OCR adapter must pass, run against the mocks.
- Database tests: tenant isolation and person scope on the new tables.
- API tests: step-up on in-app signing, a quarantined return never marks a request signed, an
  unreleased extraction never emits the medicines event.

## More information

- Medical-device boundary: OCR transcribes text; it never interprets it.
  `docs/compliance/medical-device-boundary.md` is re-checked in the same PR.
- Hazard log: HZ-005 gains the OCR controls. A signature against the wrong document or by the
  wrong member is a security and records control (the hash binding, step-up and the evidence
  row), not a new clinical hazard; the CSO may decide otherwise (H-1260).
- Human actions H-1260 to H-1269.
