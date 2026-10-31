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

## Review rounds

- Round 1 (security, clinical safety and accessibility reviewer agents): the link's origin from
  configuration only, never a request header (a forged host could have fronted the token); no
  scan of everyone's notes to prefill a redaction (DPIA R13); the original shown read-only beside
  an empty box and an unchanged copy refused; days left in UK calendar days, never rounded up,
  across both clock changes, and the release preview in UK days as the API; approval says the
  rate table's period; people with date of birth and communication needs (HZ-001 same name, AIS);
  checkbox hints kept in their description and record times in their names; the link panel a
  named region whose heading takes focus, with an arrival after "I have sent the link" and a
  message when copying fails; release and changes under the right heading levels; withdraw
  confirmed as not undoable; editor rows with ids, focus on add and remove, errors naming their
  field; "wrong codes" reworded; server actions check their input. HZ-050 records the new
  controls; hazard ids added to the tests that verify them.
- For the CSO (not decided here): whether release-only holders should also withdraw a pack;
  whether a person in scope the releaser cannot see should block release; the wording of the due,
  overdue and approval messages (H-219).

## Tests

- `apps/web/src/lib/evidence-packs.test.ts`, `apps/web/src/lib/statement-of-purpose.test.ts`
  (41); `apps/web/e2e/evidence-pack.spec.ts` (3) and
  `apps/web/e2e/statement-of-purpose.spec.ts` (2), axe in light and dark on every state, re-run
  clean; `apps/api/test/evidence-packs.test.ts` (20, the link version).
