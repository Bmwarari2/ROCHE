---
status: accepted; partly superseded by ADR-0098
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# Production hosting: AWS eu-west-2, with Supabase London permitted for dev and pilots

> **Partly superseded by [ADR-0098](0098-production-on-google-cloud.md) (production on Google
> Cloud), 31/10/2026**: production on AWS eu-west-2 and the later move of pilots to RDS. Production
> runs on Google Cloud europe-west2 on Cloud SQL for PostgreSQL 17, and pilots move to Cloud SQL.
> Supabase London for development, staging and pilots is unchanged. The text below is kept as
> decided.

## Context and problem statement

Section 6 places all production personal data in AWS eu-west-2 on RDS Multi-AZ. The Appendix offers a
cheaper path for pilots: Supabase's London region for managed Postgres, moving to RDS later. Which
hosting applies to which environment?

## Decision drivers

- UK residency for all personal data.
- Tenant isolation must hold on any host: `FORCE ROW LEVEL SECURITY`, non-owner application role, pgAudit.
- PowerSync needs logical replication from the primary database.
- Pilot costs should stay low until a paying tenant justifies RDS.

## Considered options

- AWS eu-west-2 for every environment.
- AWS eu-west-2 for production; Supabase London permitted for dev, staging and pilot tenants.
- Supabase London for everything, including production.

## Decision outcome

Chosen option: "AWS eu-west-2 for production; Supabase London permitted for dev, staging and pilot
tenants", because it is the Appendix default and the hosting rule in section 6.

Conditions for any Supabase project used by Harbour:

- London region only; the project is listed in the sub-processor register for affected tenants.
- `FORCE ROW LEVEL SECURITY` on every tenant table, the application connecting as a non-owner role that
  sets `app.tenant_id` per transaction (ADR-0002), and the RLS isolation suite passing against it.
- pgAudit enabled; logical replication enabled for PowerSync.
- No Supabase client libraries in the apps: Harbour talks to it as plain Postgres through the API, so a
  move to RDS is a connection-string change plus a data migration.

### Consequences

- Good, because pilots can start cheaply without weakening isolation or residency.
- Bad, because pilot tenants later migrate to RDS (logical replication or dump and restore during a
  maintenance window), which needs a runbook in `docs/runbooks/` and tenant notice.
- Disaster recovery for production is as recorded in ADR-0001 (Multi-AZ plus point-in-time recovery,
  RPO 15 minutes, RTO 4 hours).

### Confirmation

Terraform for production creates only eu-west-2 resources; the RLS test suite runs in CI against the
same schema used on either host.

## More information

- Takes effect: Phase 0 (ADR-0001).
- How to change: supersede this ADR (for example to forbid Supabase entirely, or to name a pilot-to-RDS
  migration date).
