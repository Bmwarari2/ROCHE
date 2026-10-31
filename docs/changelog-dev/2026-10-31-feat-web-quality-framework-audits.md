# Slice 64: web screens for the framework, evidence library and audits (QUAL-001, QUAL-002, QUAL-004)

Branch `feat/web-quality-framework-audits`, stacked on `feat/quality-audit-programme` (slice 19).

## What changed

- **Framework and evidence**, in the side bar ("Framework and evidence") for anyone who works with quality evidence:
  - The framework versions, with the one in force marked by an icon and a word.
  - A version's key questions and statements, with its source.
  - The organisation's mapping editor: a local title, owner role and expected evidence for each
    statement. Each save is a new version, and earlier versions are kept.
  - Coverage in the framework's own order. A gap says "No evidence" with an icon, with a summary
    of how many statements have none.
  - A statement's evidence, with removed tags kept and marked. A tag is removed with a reason.
- **Tagging a record as evidence**, against statements of the framework version in force. It is
  reached from an incident (unless restricted) and from a completed audit.
- **Audits**, in the side bar ("Quality audits") for `quality.audit.manage`:
  - Schedules with the next due date; an overdue one says so with the date.
  - Audits in progress, mock inspections, and completed audits with their scores.
  - Templates added from a starter, their questions, scheduling at a location, and retiring
    (final, and confirmed first).
  - Starting an audit or a mock inspection.
  - One audit's answers.
  - Completion: an action for each shortfall (an owner, and an optional due date that defaults
    to the organisation's), and a self-rating chosen by a person.
  - Each audit's score with its method, findings by statement, and actions.
- **Forms**: every browser-handled form posts, and problems are said at their fields and in a
  linked summary. Arrivals focus the heading and say what was done.
- **Contracts**: a few inferred types are now exported. No API change.
- **Strings**: added in en-GB, with Welsh placeholders marked untranslated.

## Review rounds

- Round 1 (accessibility reviewer agent):
  - **Coverage page restored.** It had been ignored by git, because `.gitignore` excludes every
    `coverage/` directory. It moved to `/quality/framework/[id]/evidence-coverage`.
  - **Error messages name their item.** Each names the question or statement it is about, so the
    summary keeps one link per field.
  - **Tag form.** It is a fieldset with a hint ("Choose up to 20") and the design system's error
    style. The summary link focuses the first box, and each box is marked invalid.
  - **Page titles.** Each detail page has its own title.
  - **Links and removal forms.** A statement's record links say what and when, for example
    "Incident, tagged 03/10/2026". Each removal form is named after its tag.
  - **Targets.** Standalone links are at least 44 px tall.
  - **Text fields.** No native maximum length, so nothing is cut off silently. Labels name their
    statement ("Your title for Learning culture").
  - **Mapping editor.** Key questions and statements are headings inside their legends.
  - **Strings.** The self-rating words and the score's method are ICU strings, ready for Welsh.
  - **Smaller fixes.**
    - A template scheduled everywhere says so instead of showing an empty form.
    - The coverage summary is no longer a live region.
    - Copy: "Quality audits" in the side bar, "View evidence coverage", and "64 characters".
      The first mapping save is worded for itself.
  - **Journeys.** They now cover two summary links each focusing their own field, a tag refused
    and focused, and page titles.
  - **Left as they are (patterns shared across the app).** Focus goes to the heading after
    saving answers, and "Saving" is not announced.

## Docs

- quality.md section 20.
- Feature register: the web paths for QUAL-001, QUAL-002 and QUAL-004.
- Human actions H-850 to H-854.
- No clinical or personal-data change: the screens show what the API already returns. The
  hazard log, records of processing and data standards are unchanged.

## Tests

- `apps/web/src/lib/quality-programme.test.ts`: 19 tests.
- `apps/web/e2e/quality-programme.spec.ts`: 3 journeys, with axe in light and dark on every
  state.
