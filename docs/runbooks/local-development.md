# Local development

How to run Harbour on a laptop or in a cloud development container. Everything here uses local-only
defaults; deployed environments take secrets from AWS Secrets Manager.

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 10 (`corepack enable`).
- Postgres 16 or 17. Either `docker compose up -d postgres` (Postgres 17 with pgAudit, from
  `infra/docker/postgres`) or a local install with a superuser named `harbour_admin`:
  `CREATE ROLE harbour_admin LOGIN SUPERUSER PASSWORD 'harbour_admin_local';`
- Optional: `docker compose up -d` also starts PowerSync, its storage database and Mailpit.

## First run

```sh
pnpm install
cp .env.example .env            # optional: every value has the same local default
pnpm db:bootstrap               # roles (harbour_owner, harbour_app, ...) and the harbour database
pnpm db:migrate                 # schema, row-level security, triggers, PowerSync publication
pnpm db:seed                    # statutory figures, retention schedule, demo tenant
HARBOUR_SEED_DEMO_USERS=1 HARBOUR_DEMO_MFA=off pnpm --filter @harbour/api seed:users   # demo sign-ins (local only; refuses to run without the opt-in)
pnpm --filter @harbour/api dev  # API on http://localhost:4000
pnpm --filter @harbour/web dev  # web on http://localhost:3000
```

Demo sign-ins (password `correct horse battery staple`): `owner@example.invalid`,
`manager@example.invalid`, `nurse@example.invalid`, `carer@example.invalid`. Leave
`HARBOUR_DEMO_MFA` unset to require TOTP or a passkey, as in every real environment. For the web
journeys add `HARBOUR_DEMO_E2E_PASSKEY=1`: it gives the demo manager a passkey whose key is derived
from a published phrase, which `apps/web/e2e/support.ts` loads into Chromium's virtual
authenticator so step-up journeys confirm with a second factor (ADR-0072). Local tests only.

New cluster roles: when a migration needs a role your cluster does not have yet, `pnpm db:migrate`
stops with `role "..." does not exist`. Run `pnpm db:bootstrap` again first: it is idempotent,
creating missing roles and re-applying their memberships without touching data (it resets the
login roles' passwords to the configured ones). Migration 0054 needs `harbour_invitation_owner`,
the owner of the invitation functions, held by `harbour_owner` with `SET` but not `INHERIT`.
Staging, pilot and production clusters need the same step, run by whoever holds the administrator
credentials, before the release that carries migration 0054.

## Tests

```sh
pnpm test                       # every package; database tests create disposable databases
pnpm --filter @harbour/db test  # row-level security and isolation suite
pnpm --filter @harbour/domain test:coverage
pnpm --filter @harbour/web test:e2e   # Playwright and axe (needs the API, web and demo data)
```

Database tests connect as a superuser to create throwaway databases:
`HARBOUR_TEST_ADMIN_URL` (default `postgres://harbour_admin:harbour_admin_local@localhost:5432/postgres`).

The sync and API test suites start Vitest with Node's `--js-explicit-resource-management` flag,
because the PowerSync rules engine uses `using` declarations (configured in each `vitest.config.ts`).

## Common tasks

| Task | Command |
| --- | --- |
| New migration | `cd packages/db && npx drizzle-kit generate --name=<change>` (see the `add-migration` skill) |
| Reset the local database | `pnpm db:reset && pnpm db:migrate && pnpm db:seed` |
| Regenerate the OpenAPI document and typed client | `pnpm --filter @harbour/api openapi && pnpm --filter @harbour/contracts generate:client` |
| Regenerate the permission matrix | `pnpm --filter @harbour/domain permissions:doc` |
| Storybook | `pnpm storybook` |
| Worker (jobs) | `pnpm --filter @harbour/api worker` |
| Bundled API as in production | `pnpm --filter @harbour/api build && node apps/api/dist/server.js` |
| Mobile | see `apps/mobile/README.md` (development client; demo mode with `EXPO_PUBLIC_DEMO_MODE=1`) |

## Git hooks

Husky runs on commit: refuses `.env` files, keys and commits to `main`; Biome on staged files; a
typecheck of the packages you touched; commitlint on the message. `git push` runs the full
typecheck.

## Running CI locally

`scripts/ci-local.sh <base-sha> [labels]` runs the `ci.yml` gates on your machine, in order, and
prints a pass or fail line per gate with the log path. Use it when GitHub-hosted minutes are
used up (the account includes 2,000 a month; jobs then fail in a second with no runner and no
logs) or before pushing a large change.

```sh
git fetch origin main
PATH="/path/to/gitleaks:/path/to/oasdiff:$PATH" \
  scripts/ci-local.sh "$(git merge-base origin/main HEAD)" "clinical,data-protection"
```

- The second argument is the pull request's labels, for the docs gate.
- It needs the local Postgres above, Chromium for Playwright, and `gitleaks` and `oasdiff` on
  `PATH` (both are single binaries from their GitHub releases).
- The e2e step drops and recreates the local `harbour` database.
- It does not cover the container image builds (they need Docker), CodeQL (its licence covers
  private code only when GitHub runs it), Trivy or Maestro. Run those on `main` once hosted
  minutes are back, and record the local results on the pull request when merging without
  hosted CI.
