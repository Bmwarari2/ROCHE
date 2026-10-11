---
status: proposed
date: 2026-10-11
decision-makers: Claude Code (lead engineer); Brian accepts or rejects (H-81); the CSO accepts the printed pack for clinical use (H-84)
consulted: master prompt sections 5.2, 5.4 and 9.2; ADR-0001; ADR-0024; docs/plans/phase-1.md; docs/specs/people.md rule 10
informed: everyone working on the people, care and operations modules
---

# Hospital transfer pack PDF: a small in-house writer with an embedded font until the document renderer lands

## Context and problem statement

Slice 8 prints the hospital transfer pack (people.md rule 10, HZ-023): the person's identity and
photo, then each section with its "as of" time, and "not recorded" in bold on the first page for
each missing safety-critical section, with everything recorded that needs checking. ADR-0001 chose
Typst (tagged PDF/UA) and Playwright for PDFs, and the Phase 1 plan brings that renderer with the
packs slice (slice 11: the downtime pack, the inspector pack and the history export). The transfer
pack is needed now, on a route the server answers in one request, without a new service or binary
on the API container.

The first version of the writer used the PDF standard fonts. The slice 8 clinical review found that
they cover Windows-1252 only, so allergy substances, medicines and names printed with characters
missing: "β-lactam" printed as "?-lactam", "μg" as "?g", and Welsh ŵ and ŷ as "?" (clinical finding
M4, HZ-007 and HZ-023). A pack that misprints an allergy is not acceptable for clinical use.

## Decision drivers

- HZ-023: a transfer never waits; the PDF must always render, whatever is missing.
- HZ-007 and HZ-001: allergy substances, medicines and names print as written, or the first page
  says which section has characters that could not be printed.
- No new runtime service, sub-processor or container binary in slice 8.
- Licences on the allowed list only (section 20 rule 5, ADR-0024).
- No personal data leaves the API process to render it.
- The output must not carry active content (JavaScript, forms, external links).

## Considered options

- A small PDF writer in `apps/api/src/services/pdf.ts` that embeds Noto Sans as a TrueType font
  through its own embedding code (`apps/api/src/services/pdf-font.ts`).
- pdf-lib with @pdf-lib/fontkit in the API.
- Typst or Playwright now, ahead of slice 11.

## Decision outcome

Chosen option: "a small PDF writer that embeds Noto Sans", because it renders the pack in the API
with no new service or binary, prints every character the font has, and the pack's layout
(identity, photo, lines of text, a footer with the person's identity and page numbers) needs
nothing more.

- Fonts: Noto Sans regular and bold (SIL Open Font Licence 1.1) from
  `@expo-google-fonts/noto-sans` (MIT AND OFL-1.1, both allowed). The writer reads the font's
  character map, advance widths and metrics, embeds the whole font file as a Type 0 font with
  Identity-H encoding, and writes a ToUnicode map, so a screen reader, a search or a copy and paste
  gets the text as written. Latin (including Welsh and Polish), Greek and Cyrillic print. A
  character the font lacks prints as "?", and the first page names each section that holds one.
- Lines are wrapped by measured width; line breaks in the record start new lines.
- Photos: JPEG and PNG (8-bit, not interlaced: grey, colour, palette, with or without
  transparency), at most 4096 x 4096 pixels and 8192 on a side. A photo held in another
  format, a 16-bit or interlaced PNG, one over the limit, or one that cannot be read, is named on
  the first page so identity is confirmed another way (HZ-001). Decoding a stored photo is
  defensive: every PNG chunk read is bounds-checked, IHDR must come first and IEND must be
  present, inflating is capped at the size the header promises, and the decoder never throws.
  The pack asks the same decoder whether the photo will print, so the first page and the PDF
  agree (slice 8 review round 3).
- Each font file is compressed once per process and kept, rather than once per pack.
- The pack is rendered on request from the snapshot stored with the transfer
  (`hospital_transfer.pack`), never from the live record, so a reprint shows what went with the
  person. The response carries `content-security-policy: default-src 'none'; sandbox`,
  `x-content-type-options: nosniff` and `cache-control: no-store`.
- `build.mjs` copies the two font files and the OFL text next to the bundle (`dist/fonts`).

pdf-lib was not chosen: it and @pdf-lib/fontkit depend on pako, whose Zlib licence is not on the
licence allowlist (ADR-0024). Compression uses Node's own zlib.

### Consequences

- Good, because names and clinical words print as written in the scripts care homes meet, and the
  first page says plainly when something could not be printed.
- Good, because the transfer pack prints today with no new service, binary or licence exception.
- Good, because the output holds only text, the embedded fonts and one optional image: no scripts,
  forms or external references.
- Bad, because the PDF is not tagged (not PDF/UA): a screen reader reads it as plain text in
  order, which suits a printed handover but not an accessible export.
- Bad, because scripts outside Noto Sans (for example Chinese, Arabic or Devanagari names) print as
  "?". The NHS number and date of birth print beside the name on every page, so identity does not
  rest on the name alone (HZ-001).
- Bad, because embedding both whole fonts makes each pack about 600 KB larger than with the
  standard fonts (compressed); subsetting can come with the slice 11 renderer.
- Neutral, because the writer and the font reader are about 650 lines with their own tests, and
  are removed when the document renderer replaces them.

### Confirmation

`apps/api/test/pdf.test.ts` reads the rendered PDFs back through the ToUnicode maps
(`apps/api/test/support/pdf-text.ts`): text prints as written (β-lactam, μg, ŵ and ŷ, Ł, Œ, €),
characters the font lacks are named, line breaks and the footer on every page, JPEG and PNG photos.
`apps/api/test/people-lifecycle.test.ts`: `hazard HZ-023 prints not recorded on the first page for
each missing critical section` and the two `hazard HZ-015 prints ...` tests read the PDF the API
serves. Slice 11 replaces the writer with the Typst renderer (tagged PDF/UA with an embedded
Unicode font) and keeps those tests.

## Pros and cons of the options

### A small PDF writer with Noto Sans embedded

- Good, because there is nothing to install or patch beyond a font package, and both its licences
  are allowed.
- Bad, because there is no tagging and no font for non-Latin, non-Greek, non-Cyrillic scripts
  (above).

### pdf-lib with fontkit

- Good, because it is maintained and can embed and subset a Unicode font.
- Bad, because pako (Zlib licence) comes with it, which the allowlist does not include.
- Bad, because it adds a dependency for one document that slice 11 renders differently anyway, and
  it still does not produce tagged PDF.

### Typst or Playwright now

- Good, because it is the ADR-0001 target: tagged PDF/UA, Unicode fonts, one pipeline.
- Bad, because it brings a binary or a headless browser to the API container and the packs
  pipeline (templates, watermarking, storage) ahead of the slice that designs it.

## More information

Revisit with slice 11 (packs and governance) or sooner if a tenant needs names in a script Noto
Sans lacks printed. To change this decision, add an ADR that supersedes it.
