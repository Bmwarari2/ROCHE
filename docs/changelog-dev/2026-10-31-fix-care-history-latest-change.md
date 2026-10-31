# A record's history marks what the latest review changed

Branch `fix/care-history-latest-change`.

## What changed

- `packages/contracts` `RecordHistory`: an optional `current` field, the record as it is now in
  the same stored shape as the versions (additive, not breaking). Both
  `GET /v1/people/{id}/care-history/{table}/{recordId}` and `GET /v1/people/{id}/history` send it
  only when there is at least one earlier version, read in the same transaction, under the same
  permission, RLS and audit event as the versions; it holds no column the versions do not.
- `apps/web/src/lib/history.ts`: `versionViews` compares the newest earlier version with
  `current`, so the fields the latest review changed are marked "Changed in the next version"
  (stored objects compare regardless of key order). Risk answers show one line per question from
  the template ("Does the person need someone with them when eating? Yes"), other objects as
  "Label: value" lines, never raw JSON; statuses show in the words the record's own tab uses
  (care plan, risk assessment, advance care record, DoLS authorisation, the person).
- `apps/web/e2e/history.spec.ts`: version 1's Controls row carries the marker, Hazard does not,
  Answers read as questions with no JSON, Status reads "In use".
- Hazard log HZ-024: a control and verification row for the history marker.

## Found, not fixed here

- Consent records and DoLS legal-change reviews have no status words yet; their keys show as
  stored. Likelihood and severity show as numbers, not the scale's labels.

## What is next

- The clinical safety case v0.1.

## Human actions logged

- None.

## Tests

- `pnpm --filter @harbour/web exec vitest run src/lib/history.test.ts` (12 passing).
- `apps/api`: `vitest run test/care-follow-ups.test.ts test/api.test.ts test/care-planning.test.ts
  test/mca.test.ts` (196 passing, Postgres 16).
- `history.spec.ts` passes locally against the dev servers.
