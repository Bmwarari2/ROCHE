# Slice 11 web: evidence packs and the statement of purpose (QUAL-003, QUAL-009)

Branch `feat/web-evidence-sop`.

## What changed

- Web, evidence packs (QUAL-003, HZ-050): "Evidence packs" in the side bar for holders of
  `quality.evidence_pack.compose` or `.release`. `/quality/evidence-packs` lists packs with their
  state as an icon and a word. `/quality/evidence-packs/new` composes one: recipient, work email,
  purpose, dates (dd/mm/yyyy), locations and the people in scope ticked one by one (no
  "everyone"), staff names and the key questions asked for, every problem said at once.
  `/quality/evidence-packs/[id]` puts "What will be shared" first (recipient and bound address,
  purpose, dates, locations, people by name, staff names, the watermark, counts), then every
  record with each field's outcome (shown, redacted by hand, withheld) and its reason, the records
  left out and why (internal only), the links with their expiry in words, and the actions: add a
  person's notes, readings and incidents in the pack's dates; redact free text by hand from the
  original (a leaking copy is refused in the API's words); release or send a new link, offered
  only to a holder who did not shape the pack, with the expiry chosen and said in words, a
  read-through confirmation and the API's step-up; the link shown once in the page with the token
  in the fragment; withdraw or discard with a reason.
- Web, statement of purpose (QUAL-009, HZ-080): "Statement of purpose" in the side bar for
  holders of write, approve or `safety.notification.submit`. `/quality/statement-of-purpose` shows
  revisions waiting for CQC with the clock as an icon and a word and the due date from the API,
  and the form to record the submission (step-up); the draft with its Schedule 3 gaps, warnings,
  what changed section by section and the registration prompts; the editor (managers and
  locations added and removed, each keeping its id); approval only by someone who did not write
  or edit it (the author is told why); discard; the version in force and every version.
  `/quality/statement-of-purpose/[id]` shows one version with its changes.
- API (additive): the evidence pack manifest gives each link its `version`, which a new link must
  name; the contracts export `EvidencePackSummary` and `StatementOfPurposeChanges` types. OpenAPI
  and the client regenerated.
- Quality statement ids stay opaque until QUAL-001: the web offers the five CQC key questions as
  ids (`safe`, `effective`, `caring`, `responsive`, `well-led`), which the API accepts.
- Strings in en-GB under `quality.`; Welsh copied and listed as untranslated.
- Docs: quality.md section 16 (screens, permission matrix, tests), HZ-050 (a design control and
  verification) and HZ-080 (verification), the register's code and test paths.
  Medical-device boundary re-checked: unchanged (the screens copy records and apply the
  provider's redaction rules). No new personal data or purpose: records of processing and data
  standards unchanged.

## What is next

- The public inspector page at `/evidence` that takes the token from the fragment and calls
  `/p/evidence/code`, `/verify` and `/bundle` (not in this branch; the link the screen shows
  points there).
- The remaining record types for packs (body map, assessments, care plan sections, risk
  assessments, activities, visits, advance care records) as the API adds them.
- QUAL-001 replaces the key questions with the quality statements.

## Human actions logged

- None new (H-96 and H-97 cover the redaction rules, link defaults and registration prompts).

## Tests

- `apps/web/src/lib/evidence-packs.test.ts`, `apps/web/src/lib/statement-of-purpose.test.ts`
  (35 with the copy check); `apps/web/e2e/evidence-pack.spec.ts` (3) and
  `apps/web/e2e/statement-of-purpose.spec.ts` (2), axe in light and dark on every state, re-run
  clean; `apps/api/test/evidence-packs.test.ts` (20, the link version).
