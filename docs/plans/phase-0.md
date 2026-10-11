# Phase 0: Foundations

## Summary

Phase 0 lays the ground every later phase builds on: a TypeScript monorepo with CI quality gates;
the documents that govern the build (constraints digest, sources, ADRs, hazard log, compliance
checklists, feature register, status); the Apple-derived design system with the 15 core components;
multi-tenancy with the group layer, forced row-level security and isolation tests through the
database, the API and the sync streams; Better Auth with passkeys, TOTP and step-up; built-in roles
and scoped access; the append-only, hash-chained audit trail; the notification centre with
escalation; the forms engine skeleton; the dated rate table; the integrations framework and the
operator console API; a seeded demo tenant; the API, web and mobile skeletons; and Terraform for dev,
staging and prod in AWS eu-west-2. No care functionality ships in Phase 0.

## Appendix defaults adopted (each an ADR)

Harbour as working name (0003); residential first (0004); demo tenant only (0005); CSO artefacts now,
signature gates go-live (0006); Brian as data protection lead (0007); AWS eu-west-2, Supabase London
for dev and pilots (0008); Better Auth (0009); public store listing (0010); 7-day offline window,
30-second kiosk lock (0011); build eMAR (0012); Xero Payroll first (0013); Bedrock London for AI
(0014); pursue NHS DSCR assurance (0015); Welsh in Phase 7 (0016); children's homes in Phase 7
(0017); pricing in Phase 3 (0018); private repository (0019); company set-up as human actions (0020);
duty of candour default (0021); sponsor module in Phase 2 (0022); GP Connect gating (0023).
Further decisions taken during Phase 0: 0001 stack, 0002 tenancy and RLS, 0024 licence allowlist,
0025 shared devices (proposed), 0026 design system, 0027 ECM tolerances, 0028 certificate pinning
(proposed), 0029 mobile offline stack, 0030 web sessions and browser security.

## Task list (grouped by section 20 first actions)

1. Repository and conventions: layout, `01-CONSTRAINTS.md`, `02-SOURCES.md`, CLAUDE.md, `.claude`
   settings, skills and reviewer agents, Biome, TypeScript 6, Vitest, Playwright, Maestro,
   commitlint, Changesets, Renovate, CodeQL, gitleaks, Trivy, Syft, workflows, CODEOWNERS, templates.
2. ADR-0001, ADR-0002 and the Appendix ADRs; hazard log with the day-one hazards.
3. `packages/ui` tokens and 15 components with Storybook, light and dark, axe tests.
4. `packages/db` platform and people schema, RLS, migrations, seed, isolation tests.
5. `apps/api` (Hono, Zod, OpenAPI 3.1, Better Auth, audit, outbox) and `apps/web` shell.
6. `apps/mobile` (Expo, expo-router, PowerSync, SQLCipher, biometric lock, sync banner).
7. Terraform for dev in eu-west-2; status page (human action H-12).
8. Gate record (below), STATUS.md, feature register, then Phase 1.

GitHub issues were not created: `gh auth status` fails in the build environment (no token), so the
task list lives here and in STATUS.md (human action H-01).

## Gate (section 19): verified by Claude Code

| Gate item | Result | Evidence |
| --- | --- | --- |
| Lint and format | Pass locally | `pnpm exec biome ci .` |
| Types | Pass locally | `pnpm turbo run typecheck` |
| Unit and domain tests | Pass locally | domain 203 tests, 99% line coverage (gate 90%) |
| Cross-tenant isolation through the database | Pass | `packages/db` 78 tests against real Postgres |
| Cross-tenant isolation through the API | Pass | `apps/api` 88 tests |
| Cross-tenant isolation through the sync streams | Pass | `packages/sync` 10 tests on the PowerSync rules engine |
| Storybook builds with zero axe violations | Pass | `packages/ui` 190 tests (136 axe runs over every story in both themes); `build-storybook` succeeds |
| Web shell journeys with axe | Pass locally | `apps/web` 8 Playwright journeys (manager, care worker, nurse with a passkey, not-found, nonce CSP, `/v1` not exposed), zero serious or critical axe findings; 101 unit tests |
| Mobile | Typecheck, 341 unit tests, Android and iOS bundles build | Maestro flows run in CI on emulators (no simulator here) |
| Terraform plan is clean | `fmt`, `validate`, `terraform test` (mocked providers), TFLint, Trivy and Checkov clean; plan against AWS awaits credentials | H-04 |
| Container images | Built in CI | `images` job builds `apps/api/Dockerfile` and `apps/web/Dockerfile` (no Docker daemon here; the web standalone server was run locally in the image layout) |
| CI on GitHub | Runs on the Phase 0 pull request | `.github/workflows/ci.yml` |

## Human follow-ups

Brian signs in on dev with a passkey and sees the empty demo home (H-14). Everything else Phase 0
needs from people is in [human-actions.md](human-actions.md).
