---
status: "accepted"
date: 2026-10-16
decision-makers: Claude Code (build coordinator and lanes)
consulted: master prompt section 20 rule 9; docs/CHANGELOG-DEV.md
informed: Brian
---

# Development log entries as one file per pull request

## Context and problem statement

Master prompt section 20 rule 9 says each working session ends by "appending a short summary
(what changed, what is next, human actions logged, test status) to `docs/CHANGELOG-DEV.md`". With
several lanes working in parallel, every pull request appends to the end of the same file, so each
merge makes every other open pull request conflict there, and each conflict costs a merge and a
full CI run. How do we keep the log without the conflicts?

## Decision drivers

- Section 20 rule 9: a summary of every session must be kept, in the repository.
- Parallel lanes and stacked pull requests: shared append-only files conflict on every merge.
- The log must stay easy to read in date order and easy to review in a pull request.
- No tooling that a contributor must remember to run before committing.

## Considered options

- One file per pull request under `docs/changelog-dev/`, named by date and branch.
- Keep appending to `docs/CHANGELOG-DEV.md` and resolve conflicts as they come.
- A `merge=union` Git attribute on `docs/CHANGELOG-DEV.md`.
- Changesets-style fragments compiled into `docs/CHANGELOG-DEV.md` by a script at release.

## Decision outcome

Chosen option: "one file per pull request under `docs/changelog-dev/`", because two pull requests
never write the same file, so the log can never conflict, and the entry is still written in the
same pull request as the work it describes.

- Each pull request adds `docs/changelog-dev/YYYY-MM-DD-<branch-slug>.md` (the date the entry was
  written; the branch name with `/` replaced by `-`), using the template in
  `docs/changelog-dev/README.md`. Review rounds append to the same file.
- `docs/CHANGELOG-DEV.md` is frozen on 2026-10-16 as the history before this decision; its header
  says so and points to the new folder. Read both, in date order, for the full log.
- `CLAUDE.md` and `docs/01-CONSTRAINTS.md` say "add a dated file under `docs/changelog-dev/`" in
  place of "append to `docs/CHANGELOG-DEV.md`".

This is a deviation from the wording of section 20 rule 9, not its intent: every session still
leaves a summary in the repository, with the same contents.

### Consequences

- Good, because pull requests no longer conflict on the log, saving a merge and a CI run each.
- Good, because each entry sits beside the work it describes and is reviewed with it.
- Bad, because the log is in two places (the frozen file and the folder) and in many small files;
  a reader lists the folder to read it in order (file names sort by date).
- Neutral, because the hazard log, `docs/plans/STATUS.md` and the feature register stay single files;
  they conflict less often, since entries go in different places in them.

### Confirmation

Review: a pull request that changes code without a new or updated file in `docs/changelog-dev/` is
asked for one, and a pull request that appends to `docs/CHANGELOG-DEV.md` is asked to move the
entry. A CI check can be added later if entries are missed.

## Pros and cons of the options

### One file per pull request

- Good, because no two pull requests write the same file.
- Bad, because the history is split across many files.

### Keep appending and resolve conflicts

- Good, because one file is simplest to read.
- Bad, because every merge conflicts the rest of the queue (observed on every slice this week).

### `merge=union` on `docs/CHANGELOG-DEV.md`

- Good, because Git would join both sides without a conflict.
- Bad, because GitHub's merge does not honour custom merge drivers, and union merges can interleave
  lines of two entries silently.

### Fragments compiled by a script

- Good, because the single file would stay the place to read.
- Bad, because it needs a script and a step someone must remember, and the compiled file would
  conflict again whenever two branches ran it.

## More information

Section 20 rule 9 of [the master prompt](../00-MASTER-PROMPT.md); the folder's
[README](../changelog-dev/README.md). Revisit if the folder becomes hard to read (for example, add a
compiled view at release). To change this decision, add an ADR that supersedes it.
