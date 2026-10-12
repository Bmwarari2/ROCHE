# Harbour build lanes: rules every lane agent follows

You are one of up to three build agents working in parallel on Harbour (repository
`Bmwarari2/ROCHE`, a multi-tenant UK adult social care platform). A coordinator opens the
reviews and merges; you build, validate, push and open the pull request, then report back.

## Read first (only the parts you need)

- `CLAUDE.md` and `docs/01-CONSTRAINTS.md` (binding). `docs/00-MASTER-PROMPT.md` sections as needed.
- `docs/plans/STATUS.md` "Next items", `docs/specs/feature-register.md`, `docs/plans/phase-1.md`.
- The spec for your slice in `docs/specs/` (its "As built" section says what is already on main).
- ADR-0002 and ADR-0071 before touching access, scope or `packages/db`. Skills in
  `.claude/skills/` (`add-migration`, `new-module`, `hazard`, `adr`) when they apply.

## Never break

- No personal data in logs, fixtures, screenshots or commits. Fixtures use invented people
  ("Ada Example"), emails on `example.invalid`, NHS numbers in the 999 range. Logs carry opaque ids.
- British English, sentence case, plain English; no emoji; status never by colour alone (icon plus
  word). Tokens and components from `@harbour/ui` / `@harbour/ui-native` only. All strings through
  the i18n catalogues (English and Welsh files; Welsh may copy English and be listed for translation
  as the existing entries are).
- Every tenant table: `tenant_id`, forced RLS, a policy, isolation tests. Database access through
  `withRequestContext`. Every request runs under the scope of the permission it uses (`scopeFor`,
  ADR-0071). Every write, care-record view and export is audited.
- Statutory figures only in the rate table. AI advisory only and off by default. No clinical
  scoring except the published validated tools. Personal data stays in the UK.
- Licences only from the allowlist in the master prompt. Secrets never in Git.
- Never commit `AGENTS.md` (add it to `.git/info/exclude` in your worktree if missing).
- No model names or ids anywhere in commits, PRs or code, except the attribution trailer below.

## Branches, commits, pull requests

- Branch from the latest `origin/main`: `feat/<area>-<slug>`, `fix/...`, `chore/...`, `docs/...`.
  Never commit to `main`; never force-push a branch someone else has pushed to.
- Conventional Commits with a scope from the 14 contexts or `web`, `mobile`, `api`, `infra`,
  `docs` (commitlint also allows `ui`, `domain`, `db`, `contracts`, `sync`, `i18n`, `config`,
  `ci`, `deps`, `repo`). End every commit message with exactly these two lines:

      Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
      Claude-Session: https://claude.ai/code/session_01K4TWvwss16WtihZQkEPifi

- **Small PRs**: aim under about 600 changed lines excluding generated files (`openapi.json`,
  `api-types.ts`, drizzle snapshots). Split by layer (schema and domain, then API, then web, then
  mobile). Past about 1,000 lines, split before opening.
- Open the PR with the GitHub MCP tools (`mcp__github__create_pull_request`; load with ToolSearch).
  Use every section of `.github/pull_request_template.md`. Label `clinical` and/or
  `data-protection` when the template sections say so (`mcp__github__issue_write` can set labels).
  End the PR body with:

      🤖 Generated with [Claude Code](https://claude.com/claude-code)

      https://claude.ai/code/session_01K4TWvwss16WtihZQkEPifi

- Do **not** merge. Do not post review comments. The coordinator reviews and merges.

## Shared files and id ranges

- Only Lane A adds database migrations under `packages/db/drizzle`. Another lane that needs one
  says so in its report and waits; the coordinator sequences it.
- Reserved ids: human actions H-200–249 Lane A, H-250–299 Lane B, H-300–349 Lane C,
  H-350–399 Lane D. Hazards HZ-080–089 A, HZ-090–099 B, HZ-100–109 C, HZ-110–119 D. ADR numbers:
  write `ADR-NNNN` as the next free number on main when you open the PR; the coordinator
  renumbers at merge if needed.
- Shared docs (`docs/plans/STATUS.md`, `docs/CHANGELOG-DEV.md`, `docs/specs/feature-register.md`,
  `docs/plans/human-actions.md`, `docs/clinical-safety/hazard-log.md`): append-style edits only
  (add your own bullet or row; do not rewrite others'), so merges resolve by keeping both sides.
- Clinical features: check `docs/compliance/medical-device-boundary.md` and update the hazard log
  in the same PR. Personal-data changes update `docs/compliance/records-of-processing.md` and
  `docs/specs/data-standards.md`.

## Validate before pushing (hosted CI is the gate)

- `pnpm install` once in your worktree. Local Postgres 16 is running; export
  `HARBOUR_TEST_ADMIN_URL=postgres://harbour_admin:harbour_admin_local@localhost:5432/postgres`
  and `DATABASE_ADMIN_URL` (same value) for database tests (they use disposable databases).
- Run only what you touched: `pnpm exec biome check <paths>`, `pnpm --filter <pkg> typecheck`,
  `pnpm --filter <pkg> test`. After API route changes: `pnpm --filter @harbour/api openapi &&
  pnpm --filter @harbour/contracts generate:client` and commit the result.
- Do **not** run the Playwright e2e suite or `scripts/ci-local.sh` locally unless your lane brief
  says so: the e2e resets the shared `harbour` database and uses ports 3000 and 4000.
- Re-read your own diff adversarially before pushing. Fail closed. Don't gold-plate: build the
  safe version and log the fuller version as a STATUS follow-up.

## Report back (your final message)

PR number and URL, branch, head SHA, a five-line summary, the hazards and human actions added,
what you ran locally and the results, anything you could not do, and the next part of your lane.
Keep it under 300 words.
