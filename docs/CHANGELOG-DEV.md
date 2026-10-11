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

## 2026-10-11: Web copy into the catalogues; text area and account menu in the design system

**What changed**

- i18n: every word in the web app's own code now comes from `@harbour/i18n` (138 new keys, 198 in
  all; a few `@harbour/ui` defaults without a prop remain, see Next):
  sign-in and set-up errors, the offline banner, people table headers, the person header, the
  break-glass sheet, the security settings page, the home tiles, notifications and error pages.
  Plurals, terminology and regulator names are ICU messages. Welsh has every key, marked
  untranslated in `cy.status.json`; new tests fail if a Welsh entry is still English but unmarked,
  or if an English message loses sentence case. `apps/web/src/copy.test.ts` parses every component
  and fails on literal copy in JSX text or in attributes people read or hear.
- `@harbour/ui`: `TextArea` (label, hint, error, character count with a maximum, described by all
  three; a polite live region reads the count once typing pauses; text is never cut off) and
  `AccountMenu` (Radix dropdown; name, email, organisation and location; link and action items;
  keyboard and screen reader behaviour unchanged). Stories in both themes; axe runs over each. The
  app bar now shortens organisation and location names on phones itself, and takes a translated
  skip link label; the app-level CSS override is gone. Story-level axe options are honoured for
  best-practice rules only (ADR-0026).
- Web shell: uses the package `AccountMenu` (now also showing the location) and `TextArea` in
  break-glass; one shared sign-out helper; break-glass reasons over 1,000 characters are refused
  by the form and the server action with a message, instead of being cut off by the browser.
- The manager journey waits for the sheet's fade-in before running axe; it had been measuring
  contrast on a half-transparent frame.

**Next**: label props for the remaining `@harbour/ui` English defaults (sidebar toggle, table
density, "None selected") before Welsh tenants; then Phase 1 as in STATUS.md.

**Human actions logged**: none.

**Tests**: `packages/i18n` 34, `packages/ui` 233 (160 axe runs), `apps/web` 142 unit and 8
Playwright journeys with axe, all passing locally; Biome, typecheck, Storybook build and the web
production build clean.
