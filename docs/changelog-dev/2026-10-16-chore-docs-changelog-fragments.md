# Development log entries as one file per pull request (ADR-0073)

Branch `chore/docs-changelog-fragments`.

## What changed

- ADR-0073: each pull request adds its own dated file under `docs/changelog-dev/`; `docs/CHANGELOG-DEV.md`
  is frozen on 2026-10-16 as the history, with a header saying so. A deviation from the wording of
  section 20 rule 9, not its intent, so the log stops conflicting between parallel pull requests.
- `docs/changelog-dev/README.md` with the naming rule and a template; `CLAUDE.md` and
  `docs/01-CONSTRAINTS.md` rule 1 point to the folder.

## What is next

- Open pull requests move their entries from `docs/CHANGELOG-DEV.md` to a file here when they next
  merge main.

## Human actions logged

- None.

## Tests

- Docs only: biome and the docs link check.
