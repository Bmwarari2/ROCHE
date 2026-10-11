---
status: proposed
date: 2026-10-11
decision-makers: Claude Code (lead engineer); Brian accepts or rejects
consulted: master prompt sections 5.2, 5.4 and 9.2; ADR-0001; docs/plans/phase-1.md; docs/specs/people.md rule 10
informed: everyone working on the people, care and operations modules
---

# Hospital transfer pack PDF: a small in-house writer until the document renderer lands

## Context and problem statement

Slice 8 prints the hospital transfer pack (people.md rule 10, HZ-023): the person's identity and
photo, then each section with its "as of" time, and "not recorded" in bold on the first page for
each missing safety-critical section. ADR-0001 chose Typst (tagged PDF/UA) and Playwright for
PDFs, and the Phase 1 plan brings that renderer with the packs slice (slice 11: the downtime pack,
the inspector pack and the history export). The transfer pack is needed now, on a route the
server answers in one request, without a new service or binary on the API container.

## Decision drivers

- HZ-023: a transfer never waits; the PDF must always render, whatever is missing.
- No new runtime dependency, sub-processor or container binary in slice 8.
- Licences on the allowed list only (section 20 rule 5).
- No personal data leaves the API process to render it.
- The output must not carry active content (JavaScript, forms, external links).

## Considered options

- A small PDF 1.4 writer in `apps/api/src/services/pdf.ts` (text in the standard Helvetica fonts,
  an optional JPEG photo, A4 pages, a footer on every page).
- pdf-lib (MIT) in the API.
- Typst or Playwright now, ahead of slice 11.

## Decision outcome

Chosen option: "a small PDF 1.4 writer", because it renders the pack in the API with no dependency
or binary, and the pack's layout (identity, photo, lines of text, a footer with the person's
identity and page numbers) needs nothing more. The pack is rendered on request from the snapshot
stored with the transfer (`hospital_transfer.pack`), never from the live record, so a reprint
shows what went with the person.

### Consequences

- Good, because the transfer pack prints today with no new dependency, service or licence review.
- Good, because the output holds only text, one optional JPEG and the standard fonts: no scripts,
  forms or external references.
- Bad, because the PDF is not tagged (not PDF/UA): a screen reader reads it as plain text in
  order, which suits a printed handover but not an accessible export.
- Bad, because the standard fonts cover Windows-1252 only: characters outside it (for example the
  Welsh ŵ and ŷ, or names in non-Latin scripts) print as "?". The NHS number and date of birth
  print beside the name on every page, so identity does not rest on the name alone (HZ-001).
- Neutral, because the writer is about 200 lines with its own tests through the API, and is
  removed when the document renderer replaces it.

### Confirmation

`apps/api/test/people-lifecycle.test.ts`: `hazard HZ-023 prints not recorded on the first page for
each missing critical section` reads the rendered PDF. Slice 11 replaces the writer with the
Typst renderer (tagged PDF/UA with an embedded Unicode font) and keeps that test.

## Pros and cons of the options

### A small PDF 1.4 writer

- Good, because there is nothing to install, patch or licence.
- Bad, because there is no tagging and no Unicode font (above).

### pdf-lib

- Good, because it is maintained, MIT-licensed and can embed a Unicode font.
- Bad, because it adds a dependency for one document that slice 11 renders differently anyway, and
  it still does not produce tagged PDF.

### Typst or Playwright now

- Good, because it is the ADR-0001 target: tagged PDF/UA, Unicode fonts, one pipeline.
- Bad, because it brings a binary or a headless browser to the API container and the packs
  pipeline (templates, watermarking, storage) ahead of the slice that designs it.

## More information

Revisit with slice 11 (packs and governance) or sooner if a tenant needs Welsh or non-Latin names
printed. To change this decision, add an ADR that supersedes it.
