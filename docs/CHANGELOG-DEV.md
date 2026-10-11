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

## 2026-10-11: Phase 1 slice 3, validated tools and chart rules (domain)

**What changed**

- `packages/domain/src/care/`: NEWS2 (RCP 2017, charts 1, 2 and 4), MUST (BAPEN, 2011 review),
  Waterlow (2005 card) and Braden (1988 form) as pure calculators that return the tool version,
  score, band, workings and triggers, and a typed error with no total for missing or impossible
  input; the NG249 falls pathway (triggers only, never a score); late and future entries; fluid
  balance days in UK time (23- and 25-hour days); IDDSI levels and the prescribed-level check;
  repositioning intervals; Bristol scale and the no-movement prompt; weight frequency; body map
  regions, side agreement, pressure ulcer categories and the incident and safeguarding prompts.
- Every tenant default comes from the rate table through `resolveCareRates`; tests read the real
  `docs/specs/rates.md`. New row `bowel.no_movement_prompt_days` (3, tenant default, to verify).
- Hazard log: HZ-012, HZ-014, HZ-016, HZ-017 and HZ-019 domain tests passing (HZ-009 care tests
  added); register rows CARE-003, CARE-006, CARE-007, CARE-010 and CARE-012 now `partial`;
  medical-device boundary notes the implementation and the readings taken where a form is ambiguous.

- Corrections after review: MUST and Waterlow band the exact BMI (rounded only for display, so
  18.49 scores 2 on MUST); the NG249 falls pathway is setting-aware in NICE's words (1.1.7 in
  residential care, 1.1.3 and 1.1.4 in the community, 1.1.6 for no fall); Braden uses the
  publisher's band wording; the Waterlow readings are tabled in the medical-device boundary.

**Next**: slice 4 (care record schema and API) stores these results and decides whether a late entry
is measured from device or server time; Waterlow and Braden stay off for real tenants until H-25 is
closed.

**Human actions logged**: none new; H-25 (licence terms and regulatory opinion) covers Waterlow and
Braden. The CSO should review the readings listed in the medical-device boundary (H-21).

**Tests**: `packages/domain` 687 passing, 99.9% line coverage; `packages/db` 78 passing (rate table
seed).

## 2026-10-11: Phase 1 slices 2 and 4a, working days

**What changed**

- Task and workflow engine (PLAT-011): tasks with owner, due window, evidence and states; recurring
  series in UK local time materialised 48 hours ahead; overdue escalation to the nurse in charge;
  workflows with permissions, reasons, step-up, separation of duties and SLAs from the rate table.
- Document store and retention core (PLAT-009, PLAT-012): versioned documents with categories,
  content sniffing, ClamAV scanning (mock in development), typed-name signatures, person photos;
  legal holds; destruction with certificates that deletes every S3 version (ADR-0031).
- Point-of-care record (slice 4a; CARE-009, CARE-010, CARE-012 partial): append-only notes,
  observations and body-map marks with device-generated ids, late-entry and clock-drift flags
  measured from when the entry was made on the device, corrections by supersede; vital signs
  scored with NEWS2 and escalated to the nurse in charge; IDDSI checks; fluid balance by UK day;
  body-map side agreement and safeguarding prompts; the person's care profile.
- Working days (`docs/specs/calendar.md`, `bank_holiday`): GOV.UK bank holidays 2024 to 2028 per
  nation, a working-day deadline helper, and a `working_days` SLA unit for workflows.
- Web copy moved into the i18n catalogues, and `TextArea` and `AccountMenu` added to `@harbour/ui`
  (pull request #7).
- CI on the Phase 0 pull request is green: gitleaks scoped to a pull request's commits, CodeQL
  gated locally from SARIF, unfixable audit advisories recorded as exceptions.

**Next**: slice 4b and the domain rules for slices 6, 7 and 8 (in progress on their own branches),
then their schema and API.

**Human actions logged**: H-16 (ClamAV sidecar), H-17 (enable code scanning), H-21 updated.

**Tests**: `packages/domain` 813, `packages/db` 112, `apps/api` 131, all passing locally.

## 2026-10-11: Phase 1 rules for handover, people, MCA and incidents; care planning built

**What changed**

- Shift handover and round view rules (slice 5 domain, HZ-018), revised after a clinical safety
  review: shifts to the minute with any number per location, unacknowledged urgent alerts and
  skipped tasks carried over, refusals from every chart, acknowledgement by items seen.
- People lifecycle spec and rules (slice 8 domain): states and the read-only rule after exit,
  pre-admission and decision to admit, beds, property and keys, welcome checklist, About Me, review
  scheduler, hospital transfer pack, discharge, transfer and death workflows, sharing, the weekly
  break-glass report; hazards HZ-022 and HZ-023.
- Care planning built end to end (slice 4b): care plans with publication and sign-off, risk
  assessments rated with the NPSA matrix (ADR-0032 proposed), validated tools run on the server
  with MUST rescreen and weight schedules, advance care records with the resuscitation status on
  every person summary (HZ-015), activities and Reg 9A visits; migrations 0016 and 0017; hazards
  HZ-024 and HZ-025.
- Consent, capacity, best interests and DoLS rules, and the incident classifier for CQC
  regulations 16 and 18, RIDDOR, s.42, candour (20(9)), LeDeR, medical examiner, missing persons
  and UKHSA, with clocks, outbreak detection and the post-fall checklist (slices 6 and 7 domain);
  the safety spec corrected against the regulations; hazards HZ-026 and HZ-027.
- CI: the breaking-change check reads the OpenAPI document again (inclusive bounds); the
  accessibility scans wait for animations; test database teardown no longer races.
- The API and worker survive an idle database connection being ended (pool error listeners).

**Next**: schema and API for slices 6 and 7, then 8, then 5; web UI and offline Care mode.

**Human actions logged**: H-27, H-28, H-38, H-39, H-58 to H-66; H-22 and H-25 extended.

**Tests**: `packages/domain` 1,836, `packages/db` 142, `apps/api` 161, all passing locally.

