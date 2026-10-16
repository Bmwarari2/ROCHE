# Harbour constraints digest

Imported into every Claude Code session by `CLAUDE.md`. It condenses sections 4–7 and 20 of
`docs/00-MASTER-PROMPT.md` (cited as §n); read the cited section for detail. The master prompt wins
over this digest and a regulation wins over the master prompt: record any such conflict in an ADR.

**Priorities, in order (§3)**: safety of the person; compliance as a feature; offline-first at the
point of care; configurable, never forked; UK residency, least privilege, immutable audit; WCAG 2.2 AA
and plain British English; vertical slices with tests.

## Tenancy and access (§4, ADR-0002)

- Tenant = one provider (CQC provider ID) with locations (CQC location ID, ODS code) running services
  (residential, nursing, supported living, domiciliary, complex care, live-in, respite, day service). An
  optional group gives read-only consolidated reporting, shared policies and TUPE transfers; tenant data
  stays isolated. Devolved nations load a nation pack by configuration.
- RBAC decides what; attribute scope (location, team, assigned people, time window) decides to whom.
  Enforce every check in the API and again in Postgres row-level security.
- Permissions are `module.resource.action`; roles are versioned per-tenant bundles of permissions and
  scope rules. Acting-up is a time-boxed grant, never a role edit. Agency access ends at shift end plus
  2 hours; professionals and inspectors get expiring access.
- Separation of duties: two distinct users for controlled drugs and for residents' money over the tenant
  limit; the incident raiser cannot close it; the ledger recorder cannot approve; only
  `safety.notification.submit` holders submit CQC notifications, with step-up authentication.
- Break-glass needs a typed reason, alerts the Registered Manager and data protection lead, and is
  reported weekly. Operator impersonation needs a tenant approval ticket and is visible to the tenant.

## Non-negotiables (§5): acceptance criteria for every phase

- **Data protection (§5.1)**: provider is controller, Thapsus is processor. Never use consent as the
  lawful basis for care records; it covers only optional processing (portal photos, marketing, AI on free
  text). Build the DSAR workbench (one month, extendable to three, clock pauses), breach register (72-hour
  ICO clock), complaints (30-day acknowledgement), in-app DPIA sign-off, processing and sub-processor
  registers, retention with legal hold (soft delete, then crypto-shred with a certificate;
  `docs/specs/retention.md`), the national data opt-out flag and a free full export. No solely automated
  significant decisions.
- **Clinical safety (§5.2)**: DCB0129. Update `docs/clinical-safety/hazard-log.md` in the same PR; every
  hazard has a test. Medical-device boundary: store, display, transmit and apply tenant-configured rules;
  never produce a diagnosis, prognosis, risk score or treatment recommendation. Validated tools are
  calculated exactly as published, show the formula and link the tenant's escalation policy. Re-check
  `docs/compliance/medical-device-boundary.md` in every clinical PR.
- **Security (§5.3)**: OWASP ASVS 5.0 L2, MASVS L2. Passkeys and TOTP (SMS only by documented
  exception); MFA for every role reading care records; step-up for controlled drugs, residents' money,
  export and break-glass. NCSC passwords: 12+ characters, deny-list, no expiry, throttle not lockout. TLS
  1.2+; AES-256 at rest, SQLCipher on mobile; secrets only in the managed store. Logs in UTC,
  tamper-evident, opaque IDs; security logs kept 6+ months. Fix CVSS 7+ within 14 days. `tenant_id` on
  every row, `FORCE ROW LEVEL SECURITY`, a non-owner app role setting `app.tenant_id` per transaction;
  prove isolation through the API and through PowerSync streams (replication bypasses RLS). Root or
  jailbreak blocks eMAR; remote wipe on loss.
- **Accessibility (§5.4)**: WCAG 2.2 AA, axe-core in CI, 44 px targets, visible focus, 200% text,
  reduced motion, status as icon plus word, never colour alone. Accessible Information Standard needs show
  on every screen and print. All strings through ICU i18n; en-GB first, Welsh ready; dd/mm/yyyy, 24-hour.
- **Audit (§5.5)**: append-only `audit_event` (no UPDATE or DELETE grants) for every write, care-record
  view, export, login, permission change and sync; pgAudit on. Clinical and money events are immutable;
  corrections are new events with `supersedes_id`, shown struck through. Every record has a history view
  and a signed PDF export.

## Stack and residency (§6, ADR-0001)

- pnpm, Turborepo, TypeScript 6 strict, Biome; Next.js 16; Expo SDK 57; Hono, Zod, OpenAPI 3.1;
  Postgres 17, Drizzle, RLS; PowerSync self-hosted; pg-boss; Better Auth; S3 SSE-KMS; OpenFeature with
  Flagsmith; Terraform. Change a default only through an ADR.
- The web tier never opens a database connection; web and mobile share one typed API client. The 14
  bounded contexts (`platform`, `people`, `care`, `medicines`, `safety`, `quality`, `workforce`,
  `scheduling`, `operations`, `finance`, `comms`, `insights`, `integrations`, `ai`) are the only module
  names, permission prefixes and commit scopes. Modules talk through outbox events; no cross-module joins.
- Notes, observations, administrations and incidents are append-only with client UUIDs and idempotent
  inserts. Mutable aggregates use `expected_version`; a stale write becomes a review task.
- Production personal data lives only in AWS eu-west-2. Supabase London is allowed for dev, staging and
  pilots (ADR-0008). Vercel `lhr1` or Fly.io `lhr` may host the stateless web tier only. No personal data
  on hosts without a UK region. Disaster recovery: Multi-AZ plus point-in-time recovery, RPO 15 minutes,
  RTO 4 hours; offline mobile is the continuity path.
- Statutory figures live in `rate_table`, seeded from `docs/specs/rates.md`, never as literals. AI is off
  by default, advisory only and reached only through the AI gateway.
- Budgets: web first paint under 1.5 s; mobile cold start under 2 s; point-of-care actions under 100 ms;
  60-bed sync under 30 s on 4G; virtualised lists.

## Repository and version control (§7)

- Trunk-based; `main` protected (linear history, signed commits, required checks). Branches
  `feat/<area>-<slug>`, `fix/…`, `chore/…`, `docs/…`; rebase, delete after merge. PRs under 400 lines
  where possible, using the template (clinical-safety and data-protection impact, migration, rollback).
- Conventional Commits (`feat(care): …`); scopes are the contexts plus `web`, `mobile`, `api`, `infra`,
  `docs`. Changesets for versions. ADRs in MADR 4. Secrets never enter Git (`.env.example`; gitleaks).
- Migrations are forward-only with expand-and-contract; mobile tolerates one schema version behind.

## Quality gates (§7): all green on every PR

- Types and lint: `tsc --noEmit` and Biome clean; no `any` without a `// why` comment.
- Vitest: domain packages at 90% line coverage; table-driven tests for every regulatory rule.
- Database: migration check; each table proven to deny cross-tenant access.
- API: OpenAPI diff; breaking changes need a major version and migration note.
- E2E: Playwright per module with axe (zero serious); Maestro offline journeys.
- Security: CodeQL, gitleaks, Trivy, Syft SBOM, `pnpm audit` with no critical or high.
- Performance: Lighthouse CI and mobile bundle budgets.
- Docs: a `clinical` or `data-protection` label fails the PR if spec and hazard log are untouched.

## Working agreement (§20)

1. Start each session with `docs/plans/STATUS.md` and `docs/specs/feature-register.md`; take the next
   incomplete item. End by updating both and adding a dated file under `docs/changelog-dev/`
   (ADR-0073; `docs/CHANGELOG-DEV.md` is frozen history).
2. Never wait for people. Open items take the Appendix default as an ADR; sign-offs, certifications and
   submissions go in `docs/plans/human-actions.md`. If blocked, build against a contract-tested mock, log
   it, continue.
3. Spec, schema, permission matrix and test list before code; tests first for domain rules. Order:
   schema and domain, API, web, mobile, integrations, docs.
4. Update the hazard log, `docs/compliance/records-of-processing.md` and `docs/specs/data-standards.md`
   in the same PR as the code that affects them.
5. Licences: MIT, Apache-2.0, BSD, 0BSD, ISC, MPL-2.0, PostgreSQL, OFL (fonts), CC0, Unlicense,
   BlueOak, Python-2.0; FSL for PowerSync only. A service receiving personal data joins the
   sub-processor register and DPIA.
6. Done means spec, code, tests, audit events, retention class, permissions, hazard review,
   data-protection check and release note (§19).

## Never break

- No personal data in logs, fixtures, screenshots or commits; fixtures use invented people ("Ada
  Example"), `example.invalid` emails and 999-range NHS numbers.
- No SF Pro fonts or SF Symbols (system stack plus Inter; Lucide icons). No emoji anywhere.
- British English, sentence case, plain English. No colour-only status.
- No clinical scoring except published validated tools. No AI output changes state without a human.
- No statutory figure as a literal. Personal data stays in the UK.
