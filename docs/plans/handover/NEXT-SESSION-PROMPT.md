# Prompt for the next Harbour session

Paste everything below the line into a new Claude Code session on `Bmwarari2/ROCHE`.

---

You are continuing the build of Harbour, a multi-tenant platform for UK adult social care, in
`Bmwarari2/ROCHE`. The master specification is `docs/00-MASTER-PROMPT.md`; the constraints digest
is `docs/01-CONSTRAINTS.md` (imported by `CLAUDE.md`). Start by reading `CLAUDE.md`,
`docs/plans/STATUS.md`, `docs/specs/feature-register.md` and this folder's `HANDOVER.md` and
`lane-rules.md`.

## Standing instructions from the owner

- Build per `docs/00-MASTER-PROMPT.md`. Never stop for approvals. Open questions take the
  Appendix default as an ADR. Sign-offs, certifications and anything only a person can do go in
  `docs/plans/human-actions.md`, and you carry on.
- Review and merge the PR stack yourself: a reviewer-agent pass on every PR (security for
  db/api/sync/infra, clinical for care/medicines/safety/notifications, accessibility for UI), one
  summary comment on the PR, then a merge commit with `expectedHeadSha`. Never merge without a
  reviewer pass and green hosted CI.
- No personal data in logs, fixtures, screenshots or commits (invented people such as "Ada
  Example", `example.invalid` emails, 999-range NHS numbers). No SF Pro fonts, no emoji, British
  English, sentence case. Every regulatory rule has a table-driven test; every statutory figure
  lives in the rate table. AI is advisory only and off by default. Personal data stays in the UK.
- Secrets never in Git. Licences from the allowlist only. Branch per task, Conventional Commits
  scoped to the 14 contexts or web/mobile/api/infra/docs, never commit to main, never force-push a
  shared branch, keep Git's default merge-commit titles. Never commit `AGENTS.md`. No model names
  in commits, PRs or code.
- **The mobile apps are paused by the owner (16/10/2026).** Do not work on `apps/mobile`, the
  phone sync streams or the screens gate unless the owner says so. PR #50 (round screen data) is
  a draft with its round 1 fixes unfinished; `feat/mobile-round-screen` holds unreviewed work in
  progress. Leave both.
- Keep cost down. The account has hit its session and weekly usage limits. Run at most two build
  lanes plus their reviewers at once, batch reviews (one reviewer can take a whole stack), and
  have lanes commit and push working state often so a limit stop loses little.
- Faster process: PRs about 600 lines (tests may push past it; split code past about 1,000); at
  most two review rounds (round 1 full, round 2 fix commits only; a coordinator check of any final
  small fix); a High always blocks; a Medium blocks only if introduced with a realistic harm path
  and no mitigation; everything else goes to STATUS follow-ups. Don't gold-plate. Keep the owner
  informed in short updates.
- Update the build tracker https://claude.ai/artifact/7c8zgg7CZYHZSh3WY32qtV through ArtifactData
  (read a document, then write with `if_version`) when a PR opens or merges. Collections: `steps`
  (ids `p1-b01`..., `p1-g01`..., `p2-...`) and `meta/status` (the headline).
- When the build reaches the definition of complete (§19), run
  https://github.com/cloudflare/security-audit-skill read-only against the repository (MIT, the
  owner has checked it), then fix what it finds.

## Where things stand

Read `HANDOVER.md` in this folder for PR-by-PR detail. In short:

- Merged on 13/10 to 16/10: #32 to #44 (downtime schema, phone sync and offline actions, the web
  consent/capacity/DoLS tab, flags, admin sign-out and idle timeouts, back-entry columns,
  invitation rules, shared pack helpers), #48 (invitation store, migration 0054) and #49
  (statutory notifications on the incident page).
- Migrations on main end at 0054. The downtime API stack takes 0055; draft #50 holds 0056.
- Human actions run to H-260 (Lane B used H-250 to H-260; Lane A H-200 to H-2xx; Lane C H-300 to
  H-310; Lane D H-350 to H-355). Hazards: reserved ranges HZ-080 to HZ-119 by lane.
- STATUS items run to 20 (19 incidents, 20 invitations); take the next free number.

## What to do next, in order

1. If the downtime stack (#45 to #47, Lane A) is not yet merged, finish it: confirm the round 1
   fixes landed (see `HANDOVER.md`), run round 2 on the fix commits with one security and one
   clinical reviewer, merge #45, retarget and merge #46 then #47 (renumbering its migration to
   0055 if not done).
2. Then the downtime outages API (3c, `feat/operations-outages-api`, work in progress) and the
   back-entry on the care routes (3d, including sending a refused second correction to the
   refused-entry review, HZ-006).
3. Web, Lane B: the statutory notification pages (`/notifications/statutory` and
   `/notifications/statutory/{id}`, which the overdue alert links to), then the incident forms
   (record, answer the classifier's questions, review and close, prepare, submit or mark not
   required with step-up). Lane B's earlier, unreviewed start on the pages is archived in
   `docs/plans/handover/wip/` (a tar of the new files and a patch against an old base); reuse
   what still fits, then delete the folder in that PR.
4. Platform, Lane D: the invitation routes and accept page (STATUS item 20), then
   `fix/platform-mfa-session-factor` (MFA counts only when the session used a passkey or a
   verified TOTP code; a test that a password-only session of a passkey holder is refused care
   records).
5. Then the remaining web and API items in STATUS and the feature register, the non-mobile parts
   of the Phase 1 gate (inspector pack renders, WCAG scans clean, every hazard has a test, safety
   case v0.1), and Phase 2 without the mobile work.

## Practicalities

- Local Postgres: `service postgresql start`; admin URL
  `postgres://harbour_admin:harbour_admin_local@localhost:5432/postgres` exported as
  `HARBOUR_TEST_ADMIN_URL`. Run `pnpm install` in each worktree before committing (the pre-commit
  hook typechecks).
- GitHub: use the GitHub MCP tools; `curl` to `api.github.com` works through the proxy for reads
  and re-runs. The proxy blocks deleting branches; ask the owner to delete stale ones
  (`feat/mobile-offline-round-actions`).
- The repository must stay public for free Actions minutes and code scanning; on 15/10 it had
  been made private and every job was refused for billing until the owner made it public again.
  If CI jobs fail with "not started because recent account payments have failed", tell the owner.
- Commitlint ignores any commit message starting with "Merge ".
