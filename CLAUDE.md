# Harbour

Multi-tenant platform for UK adult social care (Thapsus Cargo Ltd). The master specification is
`docs/00-MASTER-PROMPT.md` (read the sections you need; do not import it whole). Constraints digest:

@docs/01-CONSTRAINTS.md

## Start of every session

Read `docs/plans/STATUS.md` and `docs/specs/feature-register.md`, pick the next incomplete item, and
at the end update both and append a summary to `docs/CHANGELOG-DEV.md` (section 20 rule 9).

## Run and test

- Install: `pnpm install` (Node 22, pnpm 10). Local Postgres: see `docs/runbooks/local-development.md`.
- Everything: `pnpm lint`, `pnpm typecheck`, `pnpm test` (database tests need `HARBOUR_TEST_ADMIN_URL`).
- Database: `pnpm db:bootstrap`, `pnpm db:migrate`, `pnpm db:seed`; new migration: the `add-migration` skill.
- API: `pnpm --filter @harbour/api dev` (port 4000); worker: `pnpm --filter @harbour/api worker`.
- Web: `pnpm --filter @harbour/web dev` (port 3000); E2E: `pnpm --filter @harbour/web test:e2e`.
- Design system: `pnpm storybook`. Mobile: see `apps/mobile/README.md`.
- After changing API routes: `pnpm --filter @harbour/api openapi && pnpm --filter @harbour/contracts generate:client`.

## Rules that are easy to break

- Branch per task (`feat/<area>-<slug>`), Conventional Commits with a bounded-context scope, never
  commit to `main`. PR template sections are mandatory.
- No personal data in logs, fixtures, screenshots or commits. Fixtures use invented people, emails on
  `example.invalid` and NHS numbers in the 999 range. Logs carry opaque ids only.
- Every tenant table gets `tenant_id`, forced RLS and a policy (a test fails otherwise). Database
  access goes through `withRequestContext`. Read ADR-0002 before touching `packages/db`.
- Statutory figures live in the rate table (`docs/specs/rates.md`), never in code.
- Regulatory rules get table-driven tests first. Domain coverage stays at or above 90%.
- UI: tokens and components from `@harbour/ui` only; British English, sentence case, no emoji, status
  never by colour alone. See `packages/ui/CONTENT.md`.
- Clinical features: check `docs/compliance/medical-device-boundary.md` and update
  `docs/clinical-safety/hazard-log.md` in the same PR (label `clinical`). Personal-data changes update
  `docs/compliance/records-of-processing.md` and `docs/specs/data-standards.md` (label `data-protection`).
- AI features are advisory only, off by default, and go through the AI gateway.
- Use the reviewer agents in `.claude/agents/` before merging security, clinical or UI changes.
