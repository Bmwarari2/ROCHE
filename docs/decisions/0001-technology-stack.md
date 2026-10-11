---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, via the master prompt defaults); recorded by Claude Code
consulted: master prompt section 6 and the technology sources in docs/02-SOURCES.md
informed: everyone working in this repository
---

# Technology stack, hosting, residency and disaster recovery

## Context and problem statement

Harbour is a multi-tenant platform for UK adult social care that must run on the web, iOS and Android,
work offline at the point of care, keep personal data in the UK, and be maintainable by a very small
team. Section 6 of `docs/00-MASTER-PROMPT.md` sets a default stack and says it changes only through an
ADR. This ADR records that stack as accepted, pins the versions actually in use in Phase 0, and records
the deliberate disaster-recovery decision that follows from AWS having no second UK region.

## Decision drivers

- One language end to end, with shared Zod schemas and one typed API client for web and mobile.
- Offline-first mobile with a server-authoritative sync model that suits append-only care records.
- UK data residency for all personal data (section 6 hosting rules; NHS off-shoring guidance).
- Tenant isolation enforced in the database (Postgres row-level security), not only in code.
- Licences on the allowlist (section 20, item 8); PowerSync's FSL is the single named exception.
- Few moving parts: Postgres for data, jobs and search until there is evidence we need more.

## Considered options

- Option A: the section 6 stack (TypeScript monorepo, Next.js, Expo, Hono, Postgres with Drizzle,
  PowerSync, pg-boss, Better Auth) on AWS eu-west-2.
- Option B: the same application stack with a managed backend-as-a-service (Supabase) for all
  environments including production.
- Option C: separate native apps (Swift and Kotlin) with a JVM or .NET API.

## Decision outcome

Chosen option: "Option A, the section 6 stack on AWS eu-west-2", because it is the only option that
meets every driver at once: one language and one contract across three clients, a Postgres-native
offline sync engine, row-level isolation, and production residency in the AWS London region.
Supabase London is permitted for dev, staging and pilot tenants (see ADR-0008); option C triples the
client code for a two-person team.

### Versions in use (Phase 0)

| Layer | Choice and version | Notes |
| --- | --- | --- |
| Runtime | Node.js 22 LTS (`>=22.12.0`, `.nvmrc` 22) | |
| Package manager and build | pnpm 10.28 workspaces; Turborepo 2.11 | `apps/*`, `packages/*` |
| Language | TypeScript 6 (`~6.0.3`), strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` | TypeScript 7.0.2 is already published on npm; move to 7 only when Next.js, Expo and Drizzle certify it, through a superseding ADR |
| Lint and format | Biome 2.5 | One root `biome.json` |
| Unit tests | Vitest 4 | Playwright for web E2E; Maestro for mobile E2E |
| Web | Next.js 16.4 (App Router), React 19, Tailwind CSS 4, Radix primitives | The web tier never opens a database connection |
| Mobile | Expo SDK 57, React Native 0.87 (New Architecture, Hermes), expo-router; EAS Build, Submit, Update | op-sqlite with SQLCipher for the local store |
| API | Hono 4.13, Zod 4, OpenAPI 3.1 generated from code | One typed client; no second RPC layer |
| Database | PostgreSQL 17 (RDS Multi-AZ in production); Drizzle ORM 0.45 and Drizzle Kit 0.31 | Local test runs may use Postgres 16; see consequences |
| Offline sync | PowerSync, self-hosted in eu-west-2 (FSL licence), with its own bucket-storage Postgres | Fallback: Electric for read sync plus the same write API |
| Jobs | pg-boss 12 (at-least-once, idempotent handlers, cron) | Temporal only if workflows outgrow it |
| Auth | Better Auth 1.7 (organisations, passkeys, TOTP, device sessions); SAML or OIDC through the SSO plugin or WorkOS | See ADR-0009 |
| Files and PDFs | S3 eu-west-2 with SSE-KMS; Typst (tagged PDF/UA) and Playwright for PDFs | Antivirus scan and EXIF stripping on ingest |
| Feature flags | OpenFeature SDK with self-hosted Flagsmith | Per tenant, location and role |
| Messaging | Amazon SES (London), UK SMS gateway behind an interface, Expo push | |
| Observability | OpenTelemetry to Grafana Cloud UK region; Sentry EU region | No personal data in telemetry |
| Infrastructure | Terraform (OpenTofu-compatible): ECS Fargate, RDS, S3, CloudFront, WAF, KMS, Secrets Manager, CloudWatch; separate dev, staging and prod accounts; Docker Compose locally | Applies only from `main` with OIDC |
| AI | Internal AI gateway with Bedrock, Anthropic and Azure OpenAI adapters | Off by default; see ADR-0014 |

### Hosting and residency rules

- Production personal data lives only in AWS eu-west-2 (London): database, files, backups, logs that
  could contain identifiers, sync service and job workers.
- Supabase London is permitted for dev, staging and pilot tenants only, with `FORCE ROW LEVEL
  SECURITY`, pgAudit and logical replication for PowerSync enabled (ADR-0008).
- The stateless web tier may run on Vercel (`lhr1`) or Fly.io (`lhr`). It never hosts the database or
  files.
- Hosts without a UK region never hold personal data: Railway, Render and Hetzner have none, and
  Cloudflare's jurisdiction restriction has no UK option.
- Any model inference that leaves the UK is disclosed in the sub-processor register and the DPIA.

### Disaster recovery (deliberate decision)

AWS has no second UK region. A cross-region replica would place personal data in Ireland or elsewhere,
breaking the residency rule above and the promise made to tenants. We therefore accept a single-region
design:

- RDS Multi-AZ (synchronous standby in a second London availability zone) for availability.
- Automated daily snapshots plus point-in-time recovery, retained 35 days, with a quarterly restore drill
  recorded in `docs/runbooks/restore.md`.
- Targets: recovery point objective (RPO) 15 minutes; recovery time objective (RTO) 4 hours.
- Business continuity during a regional outage is the mobile app's offline mode: devices hold the
  offline window of records for assigned people (ADR-0011) and keep working, and every location has the
  nightly downtime pack (MAR, care plan summaries, allergies, PEEPs, contacts) printed or cached on the
  kiosk (master prompt 13.4), with a back-entry workflow when service returns.

### Consequences

- Good, because one language, one schema library and one API contract serve web, mobile, API and
  partner integrations.
- Good, because tenant isolation is enforced by Postgres RLS and tested through the API and through
  PowerSync sync streams.
- Good, because all production personal data stays in the UK.
- Bad, because a full loss of the London region would stop server-side services until AWS restores
  them; offline devices and the downtime pack carry care delivery in the meantime, and new admissions,
  billing and reporting wait. Tenants are told this in the service description and DPIA template.
- Bad, because PowerSync's FSL licence is outside the standard allowlist; it is the one named exception
  and Electric is the documented fallback.
- Neutral: local test runs may use Postgres 16 (for example where a developer machine or CI service
  container has 16). Everything Harbour relies on (row-level security with `FORCE`, pgAudit, logical
  replication, `gen_random_uuid`) behaves the same on 16 and 17. Do not depend on Postgres 17-only
  features (for example `JSON_TABLE` or `MERGE ... RETURNING`) without making the CI database gate run
  17; production and staging always run 17.

### Confirmation

- CI quality gates in section 7 (types, Biome, Vitest, RLS isolation suite, OpenAPI diff, Playwright,
  Maestro, security scans, licence checker).
- Terraform plans show every stateful resource in eu-west-2; a policy check rejects any other region.
- The restore drill is run quarterly against the RPO and RTO above.

## Pros and cons of the options

### Option A: section 6 stack on AWS eu-west-2

- Good, because it meets residency, isolation and offline requirements with mature, permissively
  licensed tools.
- Bad, because the team runs more infrastructure (PowerSync, Flagsmith, ECS) than with a managed
  platform.

### Option B: Supabase for everything

- Good, because it is cheaper and quicker to stand up.
- Bad, because production would depend on one vendor's managed platform for RLS, auth and backups,
  and the master prompt keeps production on RDS.

### Option C: separate native apps

- Good, because each platform gets fully native code.
- Bad, because it triples client work and loses shared types with the API.

## More information

- Master prompt sections 6 (architecture), 7 (backups, RPO and RTO), 13.4 (downtime pack), 17
  (mobile) and 20 (licence allowlist).
- Related: ADR-0002 (tenancy and RLS), ADR-0008 (hosting), ADR-0009 (identity), ADR-0011 (offline
  window), ADR-0014 (AI provider).
- Revisit when TypeScript 7 is certified by Next.js, Expo and Drizzle; when AWS opens a second UK
  region; or when a tenant contract requires a different recovery target.
