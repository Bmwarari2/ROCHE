# Phase 1 gate: hazard evidence, pack render test and data standards

Branch `chore/quality-gate-evidence`. These are the small gaps 1, 2 and 4 from
`docs/plans/phase-1-gate.md` (#100).

## What changed

- `apps/api/test/evidence-pack-pdf.test.ts` renders the inspector evidence pack from a fixed
  manifest with no database. It checks four things:
  - the records come in time order;
  - each value prints, or the reason it is withheld or redacted is given in words;
  - a withheld value never prints;
  - the watermark and footer appear on every page of a long pack.

  This is the gate's "inspector pack export renders" (HZ-050).
- Hazard log:
  - The five web-journey verification rows that still read "Written" or "Hosted CI" now read
    "Passing", with the CI run as evidence (HZ-013, HZ-017, HZ-090, HZ-091, HZ-092).
  - HZ-050 gains the render test.
- Feature register: the tests columns of seven rows now list the journeys or tests they omitted
  (PLAT-006, PEOP-002, CARE-013, SAFE-003, SAFE-009, QUAL-003, OPS-028).
- Data standards:
  - `admission_condition`, `welcome_checklist_item`, `key_issue` and `letter_template_version`
    each get a row.
  - `document_signature`, `legal_hold`, `workflow_instance`, `workflow_transition` and
    `notification_preference` are described with the operational tables.

## What is next

- The person's history tab journey with axe (small gap 3); then the gate items.

## Human actions logged

- None.

## Tests

- `apps/api/test/evidence-pack-pdf.test.ts` (4).
