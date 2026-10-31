# Harbour infrastructure

Production runs on **Google Cloud europe-west2 (London)**, decided by the owner on 31/10/2026 and
recorded in [ADR-0098](../docs/decisions/0098-production-on-google-cloud.md). Development, staging
and pilots stay on Supabase London ([ADR-0008](../docs/decisions/0008-production-hosting.md)). This
file is the plan for the Google Cloud estate and keeps the local Docker Compose stack.

**The Terraform in this folder still targets AWS.** The modules under `infra/modules/`, the roots
under `infra/envs/`, `infra/scripts/` and `.github/workflows/terraform.yml` were written for AWS
eu-west-2 before ADR-0098. They are kept as they are until another builder rewrites them for Google
Cloud to the plan below; do not apply them to create production. Until that rewrite lands, the plan
here is the source of truth and the modules are not.

```
infra/
  modules/ envs/ scripts/   AWS Terraform, superseded by ADR-0098, to be rewritten for Google Cloud
  powersync/powersync.yaml  PowerSync config shared by Compose and the cloud service
  docker/postgres/          local Postgres 17 image with pgAudit
```

## Organisation, folder and projects

Harbour lives in one Google Cloud organisation owned by Thapsus Cargo Ltd. Under it sits a Harbour
folder, and under the folder one project per environment (dev, staging and prod), so that billing,
access and audit logs are separate per environment, as the separate AWS accounts were meant to be.
Every environment's Terraform root calls the same stack module, so staging rehearses exactly what
prod will run.

The residency rule is enforced by policy, not by convention. The organisation policy
`constraints/gcp.resourceLocations` is set on the Harbour folder to `in:europe-west2-locations`
before any resource is created (human action H-980), so Google Cloud refuses any resource outside
London. Multi-region and global resources that hold personal data are not used. Google Cloud, like
AWS, has no second UK region, so nothing is replicated to another region.

## Terraform state

State lives in a versioned Cloud Storage bucket in europe-west2, encrypted with a Cloud KMS key
(CMEK), with uniform bucket-level access and public access prevention enforced. The `gcs` backend
locks state natively, so no separate lock table is needed. The bucket is created by hand once per
project (H-04), outside Terraform, so the state bucket never depends on the state it holds.

## CI identity

GitHub Actions authenticate through Workload Identity Federation: a workload identity pool and an
OIDC provider that trusts GitHub's token, restricted by an attribute condition to this repository.
Two service accounts can be impersonated through it. The plan account, trusted for pull requests,
can read configuration and read and lock state. The deploy account, trusted only for `main`, can
change the services the stack uses. Neither can read secret values, read objects other than state,
read log entries or connect to the database. No service account JSON key exists anywhere, and a
gitleaks rule fails the build if one is committed. Forked pull requests get no token.

## Images

Container images live in Artifact Registry in europe-west2, with immutable tags (the commit SHA),
vulnerability scanning on and CMEK. Third-party images (PowerSync, ClamAV and optionally Flagsmith)
are mirrored into the registry at pinned versions, so Cloud Run pulls only from the private
registry (H-06).

## Secrets

Secrets live in Secret Manager as regional secrets in europe-west2, encrypted with CMEK. Values are
generated inside Google Cloud, never in Terraform state, plan output or the repository. The API,
worker and PowerSync read their secrets through their own service accounts, mounted by Cloud Run,
never from environment files (H-07). The secrets are the four database URLs, `BETTER_AUTH_SECRET`,
`EVIDENCE_LINK_SECRET`, `SPEAK_UP_THROTTLE_SECRET` (ADR-0089), `SYNC_SIGNING_KEY_PEM`,
`SYNC_SIGNING_KEY_ID` and the per-role database passwords; the API refuses to start in production
without them, as now.

## Cloud Run services

Each environment runs four Cloud Run services, each with its own service account and least
privilege, reaching the database over Direct VPC egress to private IP only.

- **API** (Hono, port 4000, `GET /health`), minimum 1 instance so there is no cold start at the
  point of care. ClamAV runs as a sidecar container in the same service and is reached on
  localhost, so uploaded files never leave the instance to be scanned (H-16). The API also serves
  `/v1/sync/jwks` for PowerSync.
- **Worker** (pg-boss), the same image as the API with another command, minimum 1 instance with
  CPU always allocated, so it never scales to zero.
- **PowerSync** (port 8080), self-hosted, minimum 1 instance. Its long-lived streaming connections
  must be tested at the 60-bed load before production; if they reach Cloud Run's limits, PowerSync
  alone moves to GKE Autopilot.
- **Web** (Next.js, port 3000, `GET /api/health`), stateless. Vercel `lhr1` or Fly.io `lhr` stay
  allowed for the web tier only.

Migrations run as a Cloud Run job (`db:bootstrap` and migrations) that the deploy workflow starts
and waits for before new revisions take traffic; expand-and-contract migrations keep the previous
version working meanwhile. Containers run as uid 1000 with only `/tmp` (and the Next.js cache for
web) writable. Optional Flagsmith, off by default, would be a fifth service.

## Database

Two Cloud SQL for PostgreSQL 17 instances per environment: the main database and PowerSync's bucket
storage. Both have regional high availability in prod (a synchronous standby in a second London
zone with automatic failover), automated backups and point-in-time recovery, private IP only with
no public address, CMEK, deletion protection, TLS required (1.2 or later) and IAM database
authentication for operators. Database flags:

- `cloudsql.enable_pgaudit = on`, with `pgaudit.log = ddl,role,write`, `pgaudit.log_relation = on`
  and `pgaudit.log_parameter = off`
- `cloudsql.logical_decoding = on` (main database only, for PowerSync), with `max_slot_wal_keep_size`
- `log_connections = on`, `log_disconnections = on`, `password_encryption = scram-sha-256`

Forced row-level security and the non-owner application role
([ADR-0002](../docs/decisions/0002-tenancy-and-row-level-security.md)) are unchanged. PowerSync
replicates as `harbour_sync` from the `powersync` publication (migration 0002) and verifies client
JWTs (audience `harbour-powersync`) against `https://api.<domain>/v1/sync/jwks`. The API trusts the
Cloud SQL server certificate authority in place of the AWS RDS bundle.

**Why pgAudit does not log `read`.** Section 5.5 requires every view of a care record to be
audited, and the application does that in `audit_event` with the actor, role, tenant, device and
reason. pgAudit cannot add any of that, because every request reaches Postgres as the same
application role. Logging every SELECT (including PowerSync snapshots and RLS-filtered lists) would
multiply log volume and cost and bury the DDL, privilege and write events the database log exists
to make tamper-evident, and read statements carry search terms and filter literals, the most likely
place for personal data to leak into logs. `pgaudit.log_parameter` is off, so bound values never
reach Cloud Logging either.

## Buckets

Cloud Storage buckets in europe-west2, each with CMEK, uniform bucket-level access, public access
prevention enforced and versioning where records need it. Downloads use V4 signed URLs with short
expiry.

- **Documents**, with quarantine and clean prefixes; a file moves to clean only after the ClamAV
  sidecar passes it ([ADR-0031](../docs/decisions/0031-document-storage-scanning-and-destruction.md)).
- **Exports**, with a lifecycle rule that deletes objects after their expiry.
- **Audit archive**, with a **locked** retention policy of 365 days. A locked policy cannot be
  shortened or removed, which replaces S3 Object Lock in compliance mode and keeps H-55's choice
  irreversible.

## Keys

Cloud KMS has a regional key ring in europe-west2 with a key per purpose (database, buckets,
secrets, images, logs and state), rotated automatically. Each tenant organisation has its own key
for crypto-shredding (`docs/specs/retention.md`): destroying the key version shreds the data.
Cloud KMS destroys a key version after a scheduled delay, so the destruction certificate records the
delay and the date the version is destroyed.

## Edge, load balancing and DNS

An external HTTPS load balancer fronts the four hosts: `app.<domain>` (web), `api.<domain>` (API),
`sync.<domain>` (PowerSync) and, if enabled, `flags.<domain>`. Cloud Run services accept traffic only
from the load balancer. Cloud Armor applies the OWASP Core Rule Set at pinned rule versions (H-140)
and a per-IP rate limit; blocks answer as JSON problems (403 `edge_blocked`, 429 `rate_limited` with
`Retry-After`). Cloud CDN caches only immutable static assets (JavaScript, CSS, fonts and icons);
dynamic responses are never cached. Certificate Manager issues the certificates, an SSL policy
requires TLS 1.2 or later, and Cloud DNS holds the environment's zone. `TRUSTED_PROXY_CIDRS` is set
to the load balancer's ranges, so sign-in throttling counts each client address.

## Logging, monitoring and security

Cloud Logging writes to log buckets in europe-west2. Security logs are kept for at least 6 months
(default 400 days) in a locked bucket. Admin Activity audit logs are always on, and Data Access
audit logs are enabled for the services that hold personal data (Cloud SQL, Cloud Storage, Secret
Manager and Cloud KMS). Logs carry opaque ids only. Cloud Monitoring holds metrics, uptime checks
and alerting to the platform mailbox. Security Command Center Standard watches the organisation for
misconfiguration and threats (H-663). A billing budget alerts at 50, 80 and 100 per cent of the
monthly limit.

## Email

Google Cloud has no transactional email service. The email port stays with an SMTP adapter, and the
provider (UK or EU processing, with a data processing agreement) is human action H-08. Until it is
chosen, production email stays off; development uses Mailpit. Nothing that matters for safety
depends on email ([ADR-0060](../docs/decisions/0060-family-notification-channels.md)).

## Application changes before go-live

The API's storage and email adapters are written for S3 and SES (`apps/api/src/integrations/`) and
the production configuration requires S3 settings (`apps/api/src/config.ts`). A Cloud Storage
adapter (signed URLs, CMEK buckets) and an SMTP adapter must be built and the production
configuration changed before go-live; the ports do not change.

## Disaster recovery

- **Stance**: Cloud SQL regional high availability plus point-in-time recovery, versioned buckets
  with a locked audit archive, and the mobile app's offline mode as the business-continuity path.
  There is no cross-region copy, because it would leave the UK.
- **Targets**: RPO 15 minutes, RTO 4 hours.
- **Restore**: point-in-time recovery to a new Cloud SQL instance, then switching the connection
  (`docs/runbooks/restore.md`, drilled before go-live and each quarter). The sync-storage database
  never needs restoring: PowerSync rebuilds it.

## Status page plan (human action)

A hosted status page needs an account and a domain, so it is Brian's to set up:

1. Choose a hosted provider that will not receive personal data, or add it to the
   sub-processor register and DPIA if subscriber email addresses are collected (or turn email
   subscriptions off and publish an RSS feed instead).
2. Create the page with components: Web app, API, Mobile sync, Email delivery, and later the
   integrations.
3. Configure synthetic checks from UK or EU locations every minute against
   `https://app.<domain>/`, `https://api.<domain>/health` and
   `https://sync.<domain>/probes/liveness`, with incidents opened after 3 consecutive failures.
4. Point `status.<product domain>` at the provider with a CNAME and enable HTTPS.
5. Add the status page link to the in-app help menu and the tenant onboarding checklist.
6. Write the incident communication template (plain English, no personal data) in
   `docs/runbooks/` and log the set-up in `docs/plans/human-actions.md`.

## Local development

```sh
docker compose up -d postgres            # Postgres 17 + pgAudit, superuser harbour_admin
pnpm db:bootstrap && pnpm db:migrate     # roles, harbour database, schema, powersync publication
docker compose up -d                     # adds powersync-storage, powersync and mailpit
docker compose --profile flagsmith up -d # optional Flagsmith on http://localhost:8000
```

Ports are bound to 127.0.0.1: Postgres 5432, PowerSync bucket storage 5433, PowerSync 8080,
Mailpit SMTP 1025 and UI 8025. Variables read from `.env` (all have local defaults):
`POSTGRES_ADMIN_PASSWORD`, `HARBOUR_DB_PASSWORD_HARBOUR_SYNC`, `POWERSYNC_STORAGE_PASSWORD`,
`POWERSYNC_API_TOKEN`, `POWERSYNC_JWKS_URL`, `SYNC_JWT_AUDIENCE`, `POWERSYNC_VERSION`,
`FLAGSMITH_DB_PASSWORD`, `FLAGSMITH_SECRET_KEY`, `FLAGSMITH_VERSION` and the `*_PORT`
overrides.

## Residency rules

- Personal data is stored and processed only in europe-west2, enforced by the organisation policy.
- Never use Railway, Render or Hetzner (no UK region) or Cloudflare (its jurisdiction restriction
  has no UK option) for anything that holds personal data. Vercel `lhr1` or Fly.io `lhr` may host
  only the stateless web tier, by ADR.
