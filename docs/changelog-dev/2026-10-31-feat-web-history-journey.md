# The person's history tab journey

Branch `feat/web-history-journey`.

## What changed

- `apps/web/e2e/history.spec.ts`: the demo nurse records a choking risk assessment for Cal
  (resident 3) through the API and reviews it, then the journey opens the history tab, follows the
  link into the assessment's history, checks the earlier version (who changed it, the controls as
  they were) and the way back, with axe in light and dark themes on both pages.
- `docs/plans/phase-1-gate.md`: the WCAG gap for `/people/[id]/history` is closed; one web route
  (choose-organisation) is left, waiting on a second demo tenant.

## Found, not fixed here

- A record's history page does not mark which fields the latest review changed: the API returns
  earlier versions only, so the newest of them has nothing to compare with. Answers show as raw
  JSON and statuses as keys. Logged as the next small item in `STATUS.md`.

## What is next

- The history marker fix above, then the clinical safety case v0.1.

## Human actions logged

- None.

## Tests

- `history.spec.ts` passes locally against the dev servers (Postgres 16).
