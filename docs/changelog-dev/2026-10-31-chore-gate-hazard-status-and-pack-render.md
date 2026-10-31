# Phase 1 gate: hazard statuses and the pack render test closed

Branch `chore/gate-hazard-status-and-pack-render`. These are small gaps 1 and 2 from
`docs/plans/phase-1-gate.md`. Most of the work landed in #101; this closes what it left.

## What changed

- Hazard log: three verification rows still read "Hosted CI" or "written (e2e, runs in CI)". They
  now read "Passing", with CI run 38938760784 on `d77b416` as evidence. The run's web journey job
  passed 89 tests and skipped none. The three rows are:
  - HZ-013: `incident-forms.spec.ts`;
  - HZ-013: `incident-review.spec.ts`;
  - HZ-017: `back-entry.spec.ts`.
- HZ-050's render test row names the two new checks.
- `apps/api/test/evidence-pack-pdf.test.ts` gains two tests:
  - the PDF is well formed (`%PDF-`, `%%EOF`, a catalogue, a page tree whose count matches its
    pages), and the same manifest renders to the same bytes;
  - the title, the recipient and each record's heading print in order.
- Feature register: each of the six rows' tests columns was checked to name its journeys, and each
  file exists. The duplicate back-entry journey in OPS-028's tests column is removed.
- Gate report: small gaps 1 and 2, and their summary and section 6 rows, are marked done.

## What is next

- The person's history tab journey with axe (small gap 3); then the gate items.

## Human actions logged

- None.

## Tests

- `apps/api/test/evidence-pack-pdf.test.ts` (6).
