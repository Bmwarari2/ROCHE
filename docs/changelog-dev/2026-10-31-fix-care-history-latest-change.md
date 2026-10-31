# A record's history marks what the latest review changed

Branch `fix/care-history-latest-change`.

## What changed

- `packages/contracts` `RecordHistory`: a `latestChanged` field, the stored field keys where the
  newest earlier version differs from the record as it is now (additive, not breaking). Both
  `GET /v1/people/{id}/care-history/{table}/{recordId}` and `GET /v1/people/{id}/history` send it,
  worked out on the server in the same transaction, under the same permission, RLS and audit event
  as the versions. Keys only: the current values never leave the record's own route.
- `apps/web/src/lib/history.ts`: `versionViews` marks the newest earlier version from
  `latestChanged`, so the fields the latest review changed are marked too. Risk answers show one
  line per question from the template ("Does the person need someone with them when eating? Yes"),
  other objects as "Label: value" lines, never raw JSON; statuses show in the words the record's own
  tab uses (care plan, risk assessment, advance care record, the person).
- `apps/web/e2e/history.spec.ts`: version 1's Controls row carries the marker, Hazard does not,
  Answers read as questions with no JSON.
- Hazard log HZ-024: a control and verification row for the history marker.

## Review round 1

Security, accessibility and clinical safety reviews.

- Security (medium): the first build sent the current row (`current`). A DoLS legal-change review
  is otherwise read only with `care.dols.manage`, so `current` would have shown a decided review to
  anyone with `care.plan.read`. Now each history table names the permission its own read route
  needs (`care.dols.manage` for the legal-change review, `care.plan.read` for the other seven), and
  the API sends `latestChanged` (keys only) instead of the row. A care worker gets 403 on a
  legal-change review's history.
- Security (low): a removed (soft-deleted) record's history now returns 404, as every ordinary read
  of a removed record does, unless the reader's `platform.audit.read` ("Read the audit log and
  record history") reaches the person (the Registered Manager, at their location). Chosen over
  "no `latestChanged`" because the other routes hide removed records entirely.
- Clinical safety (L1, L3): `latestChanged` is null when the row is not the version straight after
  the newest stored one (saved again while it was read); a column the next version or the current
  row no longer has is not a change; the web finds the newest version by its index.
- Clinical safety (M1): every earlier version is labelled "Earlier version: not in use now" with an
  icon, its status is "Status at the time", and the page links to the record as it is now (the
  person's overview for personal details).
- Clinical safety (M2): answers take the template's question text only when given under the
  template version Harbour has now; otherwise the stored key in words with "asked in template
  version …".
- Clinical safety (M3): HZ-024 names every verifying test, lists the causes this change could bring
  (the latest change left unmarked, an earlier version read as current), says what is still shown
  as stored, and cross-refers HZ-015 and HZ-017. The test cases for consent and DoLS statuses are
  gone: those tables keep an `outcome`, not a `status`, so the DoLS status mapping is gone too.
- Accessibility: the newest earlier version says "Changed since this version" (it is compared with
  the record as it is now, which the page does not show); older ones keep "Changed in the next
  version". Answers, findings and other stored objects are a list in the cell. Each version's table
  is named by its "Version N" heading, and the dates are in `<time datetime>`.
- Words: the risk template by its title, the bands as "Rating 6: moderate risk" and "After the
  controls, rating 3: low risk", bed rail findings one sentence each ("Within the figure: Gap
  between the bars of the rail: 110 mm. It should be under 120 mm."), measurements as "110 mm".
- `docs/specs/care.md`: the route's permissions, removed records and `latestChanged`.
- Seven new strings in `en-GB.json`, copied into `cy.json` and listed as untranslated.

## Review round 2

Security re-review: OK to merge, with these fixed on the branch.

- `GET /v1/people/{id}/history` read a removed person's versions: row-level security
  (`app.person_in_scope`) and retention do not hide a soft-deleted person. It now applies the same
  rule as a care record's history: 404 unless the reader may use `platform.audit.read` and it
  reaches the person without break-glass.
- That rule is one check (`mayReadRemoved` in `apps/api/src/services/record-history.ts`): the
  permission usable now (MFA and step-up met, `refusalOf`), and its own scope, break-glass off,
  reaching the person; it replaces the call that worked out every permission reaching the person.
- When the record or person was removed and the reader may see it, the audit event's scope carries
  `removed: true`, nothing of the content.
- `apps/api/test/record-history-access.test.ts`: a member whose care plan permission reaches a
  resident at Harbour House but whose audit permission reaches only Harbour Lodge gets 404 for the
  House resident's removed record and removed person, and 200 for the Lodge's; a member without
  the audit permission who opened the Lodge resident by break-glass gets 404 for both; the demo
  Registered Manager reads the House ones only.
- `docs/specs/care.md`: a care plan and a DoLS authorisation are never removed on their own, so a
  section, an action or a legal-change review is checked by its own row; a route that ever removes
  a parent must remove its children or extend the check.

## Found, not fixed here

- Likelihood and severity show as numbers, not the scale's labels (`LIKELIHOOD_LABELS`,
  `SEVERITY_LABELS`).
- Consent and DoLS outcomes, a consent's capacity status and other coded fields show as stored.
- Of the person reads, only the people list was seen to filter `deleted_at`; `GET /v1/people/{id}`
  and the other person routes were not checked here.

## What is next

- The clinical safety case v0.1.

## Human actions logged

- None.

## Tests

- `pnpm exec vitest run src/lib/history.test.ts` in `apps/web` (13 passing).
- `pnpm exec vitest run test/record-history.test.ts test/record-history-access.test.ts
  test/care-follow-ups.test.ts test/api.test.ts test/care-planning.test.ts test/mca.test.ts
  test/people-lifecycle.test.ts` in `apps/api` (360 passing), and `test/scope-per-permission.test.ts
  test/route-gates.test.ts test/break-glass-search.test.ts` (46 passing), run locally on Postgres
  16 (the stack is 17).
- `history.spec.ts` passes locally against the dev servers, with axe in both themes.
