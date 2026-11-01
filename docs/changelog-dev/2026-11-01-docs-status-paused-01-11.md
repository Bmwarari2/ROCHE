# Build paused: resume notes (01/11/2026)

Branch `docs/status-paused-01-11`.

## What changed

- `docs/plans/STATUS.md` has a new "Paused 01/11/2026" section. It lists:
  - what reached `main` since the last update;
  - the open pull request;
  - the two merge batches in migration order, with the rules for building them;
  - the part-done branches, with their migration and human action numbers;
  - the Phase 2 slices not started yet;
  - the next free numbers.

## What is next

- Re-run the Playwright job on #166 and merge it.
- Finish the clinical re-review fixes on `fix/recommended-answers-care`.
- Build batch 3a, then 3b.
- Resume the builders from the newest commit on each branch.
