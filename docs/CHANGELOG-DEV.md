# Development log

One entry per working session (section 20 rule 9): what changed, what is next, human actions
logged, test status.

## 2026-10-11: Phase 0 foundations

**What changed**

- Master prompt saved; Part C moved to `docs/02-SOURCES.md`; constraints digest; CLAUDE.md; Claude
  Code settings, commit guard hook, five skills and three reviewer agents.
- Monorepo (pnpm, Turborepo, TypeScript 6, Biome, Vitest), CI workflows (lint, commitlint, licence
  allowlist, docs and medicines gates, link check, typecheck, tests on Postgres 17, coverage,
  OpenAPI drift and breaking changes, Storybook, Playwright with axe, gitleaks, Trivy, SBOM, audit,
  CodeQL, Terraform, Maestro and EAS), CODEOWNERS, templates, Renovate, Changesets, husky.
- Database: tenancy with the group layer, people, roles and grants, audit with a hash chain,
  versioning, outbox, notifications and deliveries, forms, rate and retention tables, integrations,
  operator tables; forced RLS everywhere; per-purpose roles; demo seed.
- Domain rules: permissions and 21 built-in roles, access and scope resolution, step-up,
  separation of duties, branding contrast, rates, retention, forms, escalation and quiet hours,
  NHS numbers, UK time and clock drift, integration ports.
- API: Better Auth (passkeys, TOTP, bearer), tenant context, MFA gate, step-up, people with audit,
  break-glass, notifications, audit with chain verification, forms, rates, sync tokens and uploads,
  integrations and quarantine, support access, operator console, worker jobs, migrate task,
  container image, OpenAPI 3.1 and the generated typed client.
- Design system with 15 components and Storybook; mobile skeleton with encrypted offline store;
  sync streams with isolation tests; i18n catalogues; Terraform for three environments; local stack.
- ADR-0001 to ADR-0029; hazard log HZ-001 to HZ-013 with Phase 0 tests linked; compliance
  checklists and templates; runbooks; feature register (233 rows); rates (169) and retention.

- Web shell (Next.js 16): sign-in with password then TOTP or a passkey, organisation and location
  choice, home, people and the point-of-care header with break-glass, notifications, sign-in and
  security settings; Playwright journeys with axe; container image.
- Security hardening found while integrating the web shell (ADR-0030): session tokens only reach
  the mobile app; devices listed and signed out by id (`/v1/me/sessions`); per-request nonce CSP;
  the browser reaches only `/api/auth`, passed through at run time so one image serves every
  environment; sign-in throttling per client address through trusted proxies; production refuses
  to start without every database URL; the operator database URL is now passed by Terraform.
- Dependencies: Next.js's optional `sharp` (LGPL libvips) is not installed; React types resolve per
  app (web 19.3, Expo 19.2).

**Next**: CI on the Phase 0 pull request, then Phase 1 (see STATUS.md).

**Human actions logged**: H-01 to H-57 in `docs/plans/human-actions.md`.

**Tests**: all suites pass locally (see STATUS.md totals). Not run here: Maestro on devices, a
Terraform plan against AWS, Docker image builds (no daemon).
