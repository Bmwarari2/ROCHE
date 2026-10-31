# Development log entries

One file per pull request ([ADR-0073](../decisions/0073-changelog-fragments.md); master prompt
section 20 rule 9). The history before 2026-10-16 is in [CHANGELOG-DEV.md](../CHANGELOG-DEV.md),
which is frozen.

## Naming

`YYYY-MM-DD-<branch-slug>.md`: the date the entry was first written, then the branch name with `/`
replaced by `-`. For example, branch `feat/platform-search-api` on 17 October 2026 is
`2026-10-17-feat-platform-search-api.md`. File names sort by date, so listing the folder reads the
log in order.

One file per pull request. Review rounds add a paragraph to the same file; they do not start a new
one. Never edit another pull request's file.

## Template

```markdown
# Short title of the work (register IDs)

Branch `type/area-slug`, PR #NN.

## What changed

- What was built or fixed, in plain words.

## What is next

- The next step, and anything left open.

## Human actions logged

- H-NNN, or "None".

## Tests

- The test files and counts, and anything run by hand.

## Review rounds

- Round 1: what changed after review (add as rounds happen).
```
