# Harbour infrastructure

Terraform (OpenTofu-compatible) for Harbour's Google Cloud environments, and the local Docker
Compose stack. Everything that stores or processes personal data runs in **Google Cloud
europe-west2 (London)** (ADR-0098, which replaces the AWS eu-west-2 choice in ADR-0001).

```
infra/
  modules/
    harbour_stack/      the whole platform for one environment, composed from the modules below
    project_baseline/   APIs, the gcp.resourceLocations and no-key organisation policies,
                        audit logs including Data Access, CMEK service agents
    network/            VPC, the Cloud Run subnet (Direct VPC egress, flow logs) and private
                        services access for Cloud SQL; optional Cloud NAT
    kms/                key ring and keys per purpose (sql, storage, secrets, artifacts),
                        rotated yearly
    cloud_sql_postgres/ PostgreSQL 17: regional HA, PITR, private IP only, CMEK, pgAudit,
                        logical decoding, backups in europe-west2 (used twice)
    cloud_run_service/  a Cloud Run service or job with its own service account, Secret
                        Manager secrets as variables or files, sidecars, Direct VPC egress
    gcs_bucket/         private bucket: CMEK, uniform access, public access prevention,
                        versioning, expiry, optional (lockable) retention policy
    secret_manager/     regional secrets, created empty
    artifact_registry/  Docker repository with immutable tags, CMEK
    load_balancer/      external HTTPS load balancer, Certificate Manager, Cloud Armor (OWASP
                        CRS preconfigured rules at pinned versions, rate limit), Cloud CDN for
                        the web tier's static files
    dns/                Cloud DNS records (or the list to create elsewhere)
    observability/      log buckets (security logs 400 days, lockable), sinks, log-based
                        metrics and alert policies
    github_wif/         Workload Identity Federation for this repository, plan and deploy
                        accounts (no JSON keys)
    budget/             monthly budget in pounds
  envs/
    dev/ staging/ prod/   thin root modules: providers, backend and sizing only
  powersync/powersync.yaml      PowerSync config shared by Compose and Cloud Run
  docker/postgres/              local Postgres 17 image with pgAudit
  scripts/seed-secrets.sh       generates secret values inside Google Cloud
  scripts/ci-terraform-env.sh   CI helper for backend config and inputs
```

Each environment is its own Google Cloud project (dev, staging, prod). The three `envs/` roots
call the same `harbour_stack` module, so staging rehearses exactly what prod will run.

## What runs in each environment

| Host | Served by | Notes |
| --- | --- | --- |
| `app.<domain>` | load balancer (Cloud Armor, Cloud CDN), then `web` (Next.js, port 3000) | Cloud CDN caches only what the origin marks public (static files) |
| `api.<domain>` | load balancer (Cloud Armor), then `api` (Hono, port 4000) with a ClamAV sidecar on 127.0.0.1:3310 | Also serves `/v1/sync/jwks` for PowerSync |
| `sync.<domain>` | load balancer (Cloud Armor), then `powersync` (port 8080) | Self-hosted PowerSync, unified mode, always one instance |
| `flags.<domain>` | load balancer (Cloud Armor), then `flagsmith` (port 8000) | Optional, `enable_flagsmith = false` by default |
| none | `worker` | pg-boss jobs; same image as `api`; internal ingress; CPU always allocated |
| none | `migrate` Cloud Run job | `db:bootstrap` and migrations, run by the release job |

Every Cloud Run service with a host has ingress `internal-and-cloud-load-balancing`, so it can
be reached only through the load balancer and Cloud Armor; the worker's ingress is internal.

Data: Cloud SQL `harbour-<env>-main` (PostgreSQL 17, logical decoding for PowerSync) and
`harbour-<env>-sync-storage` (PowerSync bucket storage, and Flagsmith's database when on);
buckets for documents, exports, the write-once audit archive and bucket usage logs.

## Residency rules

- Personal data is stored and processed only in europe-west2. Every environment validates its
  region, the stack refuses any other, and the project's `gcp.resourceLocations` organisation
  policy (`in:europe-west2-locations`) refuses to create a data resource elsewhere.
- Buckets are single-region `EUROPE-WEST2`, never a multi-region. Cloud SQL backups are held in
  europe-west2. Secrets are regional secrets. Log buckets are in europe-west2.
- The load balancer, its certificates, Cloud Armor and Cloud DNS are global services that hold
  no personal data. TLS terminates at Google's front ends, some outside the UK. Cloud CDN
  follows the origin's `Cache-Control`: Next.js marks `/_next/static` public and immutable and
  every page private, so no page is ever held at the edge.
- The `_Required` and `_Default` log buckets are global. Harbour's sinks route audit logs and
  application logs to its own London buckets; set the organisation's default log storage
  location to europe-west2 as part of the bootstrap so the default buckets are in London too.
- No cross-region copy of anything.
- Email has no Google Cloud service: an SMTP provider in the UK, on the sub-processor register
  and in the DPIA, set with the `smtp` variable and the `smtp-user` and `smtp-password` secrets.
- Never use Railway, Render or Hetzner (no UK region) or Cloudflare (its jurisdiction
  restriction has no UK option) for anything that holds personal data.

## Bootstrap (once per environment, a human action)

Brian, with an organisation administrator account, for each of dev, staging and prod:

```sh
ENV=dev
PROJECT=harbour-${ENV}-<suffix>

# 1. The project, linked to the billing account, in the right folder
gcloud projects create "${PROJECT}" --folder=<folder-id>
gcloud billing projects link "${PROJECT}" --billing-account=<billing-account-id>
gcloud services enable --project "${PROJECT}" storage.googleapis.com cloudkms.googleapis.com \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com iam.googleapis.com

# 2. The organisation's default log storage location (once per organisation)
gcloud logging settings update --organization=<org-id> --storage-location=europe-west2

# 3. Optional: a key for state
gcloud kms keyrings create harbour-tfstate --location=europe-west2 --project "${PROJECT}"
gcloud kms keys create state --keyring=harbour-tfstate --location=europe-west2 \
  --purpose=encryption --rotation-period=365d --next-rotation-time=+P365D --project "${PROJECT}"

# 4. The state bucket: versioned, London, uniform access, public access prevented
gcloud storage buckets create "gs://harbour-tfstate-${PROJECT}" --project "${PROJECT}" \
  --location=europe-west2 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://harbour-tfstate-${PROJECT}" --versioning
```

Then copy `envs/${ENV}/backend.hcl.example` to `backend.hcl` and `terraform.tfvars.example` to
`terraform.tfvars`, and fill them in. GCS locks state natively; no lock table is needed.

## First apply (human, with administrator credentials)

```sh
cd infra/envs/${ENV}
gcloud auth application-default login
terraform init -backend-config=backend.hcl
terraform apply          # creates the project baseline, keys, network, databases, secrets,
                         # registry, services (with the bootstrap image tag), load balancer
```

1. **DNS and certificate.** With `dns_zone_name` set, Cloud DNS holds the records; point the
   domain's registrar at `terraform output dns_name_servers`. Otherwise create the records in
   `terraform output manual_dns_records` by hand. Certificate Manager issues the certificate
   once its authorisation record resolves.
2. **Images.** Copy the ClamAV image into the registry (`<registry>/clamav:<clamav_version>`),
   and the PowerSync and, if used, Flagsmith images, then push the first api and web images
   (the release job does this from then on).
3. **Secrets.** `GCP_PROJECT_ID=${PROJECT} infra/scripts/seed-secrets.sh ${ENV}`. Add the
   SMTP provider's user and password to `smtp-user` and `smtp-password` when email is set up.
4. **Migrations.** Run the migration job (it runs `db:bootstrap`, creating the roles and their
   passwords from the secrets, then the migrations):

   ```sh
   gcloud run jobs update harbour-${ENV}-migrate --region europe-west2 --image <registry>/api:<tag>
   gcloud run jobs execute harbour-${ENV}-migrate --region europe-west2 --wait
   ```

5. **Services.** Deploy a revision of api, worker and web with the same tag
   (`gcloud run services update <name> --region europe-west2 --container main --image ...`).
6. **CI.** Set the repository variables below from the outputs, so the workflow can plan and
   apply through Workload Identity Federation.

## How GitHub deploys work

`.github/workflows/terraform.yml` signs in with `google-github-actions/auth` through Workload
Identity Federation. The pool's provider accepts tokens from this repository only (its
attribute condition), and each account trusts one token subject:

| Account | Trusts | Can |
| --- | --- | --- |
| `harbour-<env>-gh-plan` | `repo:Bmwarari2/ROCHE:pull_request` | read the project (viewer, security reviewer) and state; never secret values or data |
| `harbour-<env>-gh-deploy` | `repo:Bmwarari2/ROCHE:ref:refs/heads/main` | apply, push images, run the migration job, release; no basic roles (owner, editor) |

The apply job has no GitHub `environment:`, which would change the token subject. Service
account keys are blocked by the `iam.disableServiceAccountKeyCreation` policy.

Repository variables (Settings, Secrets and variables, Actions, Variables), per environment:
`GCP_PROJECT_ID_DEV`, `GCP_WORKLOAD_IDENTITY_PROVIDER_DEV` (output
`workload_identity_provider`), `GCP_PLAN_SERVICE_ACCOUNT_DEV`, `GCP_DEPLOY_SERVICE_ACCOUNT_DEV`,
`TF_STATE_BUCKET_DEV`, `DEV_DOMAIN_NAME`, and optionally `DEV_DNS_ZONE_NAME`,
`DEV_ALERT_EMAILS` (a JSON list) and `GCP_BILLING_ACCOUNT_ID`. Until the provider and deploy
account are set, the plan, apply and release jobs skip with a notice.

### Application releases

The `release-dev` job builds the api and web images, pushes them to Artifact Registry tagged with
the commit SHA (tags are immutable), updates and executes the migration job with the new api
image, then releases api, worker and web. Terraform ignores the services' images after the first
apply, so an infrastructure change can never roll an application back.

## Runtime contract for application images

| | api and worker | web |
| --- | --- | --- |
| Command | `node apps/api/dist/server.js`, `node apps/api/dist/worker.js` | image default |
| Port and health check | 4000, `GET /health` | 3000, `GET /api/health` |

The images bundle no CA. The api, worker, migrate job and PowerSync mount the Cloud SQL server
CA from the `db-server-ca` secret at `/secrets/cloudsql/server-ca.pem` and set
`NODE_EXTRA_CA_CERTS` to that path; they connect to the private IP with TLS (`verify-ca`), with
no Auth Proxy or connector.

API and worker environment: `NODE_ENV`, `HARBOUR_ENV`, `APP_VERSION`, `GCP_PROJECT_ID`,
`BETTER_AUTH_URL`, `WEB_ORIGINS`, `PASSKEY_RP_ID`, `TRUSTED_PROXY_CIDRS` (the load balancer,
Google's front ends and the subnet), `POWERSYNC_URL`, `SYNC_JWT_AUDIENCE`,
`DOCUMENT_STORAGE=gcs`, `GCS_DOCUMENTS_BUCKET` and `GCS_EXPORTS_BUCKET` (two different buckets),
`GCS_KMS_KEY` (the `storage` key in europe-west2), `GCS_AUDIT_ARCHIVE_BUCKET`,
`MALWARE_SCANNER=clamd`, `CLAMD_HOST=127.0.0.1`, `CLAMD_PORT=3310`, `EMAIL_FROM_DOMAIN`,
`SAFETY_CASE_VERSION`, and, once an email provider is chosen, `SMTP_HOST`, `SMTP_PORT` and
`SMTP_TLS` (unset until then). Secrets (each a whole secret version): `DATABASE_APP_URL`,
`DATABASE_AUTH_URL`, `DATABASE_OPERATOR_URL`, `DATABASE_WORKER_URL`, `BETTER_AUTH_SECRET`,
`EVIDENCE_LINK_SECRET`, `SYNC_SIGNING_KEY_PEM`, `SYNC_SIGNING_KEY_ID`,
`HARBOUR_DB_PASSWORD_HARBOUR_APP`, `HARBOUR_DB_PASSWORD_HARBOUR_AUTH`,
`HARBOUR_DB_PASSWORD_HARBOUR_WORKER`, and `SMTP_USER` and `SMTP_PASSWORD` with the provider.
Downloads stream through the API: no signed URLs, so the buckets allow no public or signed
access and need no CORS.

Migrate job: `DATABASE_HOST` (private IP), `DATABASE_PORT`, `DATABASE_NAME`,
`DATABASE_SSL_MODE=verify-ca`, `DATABASE_ADMIN_USER=postgres`, `DATABASE_ADMIN_PASSWORD`,
`DATABASE_OWNER_URL`, `HARBOUR_DB_PASSWORD_<ROLE>` for every login role, and
`SYNC_STORAGE_HOST`, `SYNC_STORAGE_PORT`, `SYNC_STORAGE_DATABASE`, `SYNC_STORAGE_ADMIN_USER`,
`SYNC_STORAGE_ADMIN_PASSWORD`, `HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE`.

PowerSync replicates as `harbour_sync` from the `powersync` publication (migration 0002) and
verifies client tokens against `https://api.<domain>/v1/sync/jwks`.

## Database settings

Both Cloud SQL instances: PostgreSQL 17, SSD storage and backups encrypted with the `sql` key,
regional availability by default (a synchronous standby in a second zone with automatic
failover), deletion protection, automated backups in europe-west2 with point-in-time recovery
(7 days on Enterprise, 35 on Enterprise Plus in prod), private IP only, encrypted connections
only, Query Insights without client addresses, a password policy, and flags:

- `cloudsql.enable_pgaudit = on`, `pgaudit.log = ddl,role,write`, `pgaudit.log_parameter = off`
- `cloudsql.logical_decoding = on` (main instance only, for PowerSync)
- `log_connections`, `log_disconnections`, `log_checkpoints`, `log_lock_waits` on,
  `log_temp_files = 0`, `log_min_duration_statement = -1`

Roles and passwords are created by `pnpm db:bootstrap` from the secrets, never by Terraform.
The flag makes pgAudit available; create the extension once on each instance, as `postgres`,
before the first migration (`CREATE EXTENSION IF NOT EXISTS pgaudit;`), as the local image's
`docker/postgres/initdb/10-extensions.sql` does. `db:bootstrap` does not do this yet.

**Why pgAudit does not log `read`.** Section 5.5 requires every view of a care record to be
audited, and the application does that in `audit_event` with the actor, role, tenant, device
and reason. pgAudit cannot add any of that, because every request reaches Postgres as the same
application role. Logging every SELECT would multiply log volume and cost and bury the DDL,
privilege and write events the database log exists to make tamper-evident, and read
statements carry search terms and filter literals, the most likely place for personal data to
leak into logs. `pgaudit.log_parameter` is off, so bound values never reach Cloud Logging.

## Logs and alerts

Audit logs (Admin Activity and Data Access for every service) and Cloud Armor requests go to the
`harbour-<env>-security` bucket in europe-west2, kept 400 days and locked in prod; Cloud Run and
Cloud SQL logs to `harbour-<env>-app` (30 days). Log-based metrics read the worker's structured
events (`escalation.unrouted.daily`, `worker.job.failed`, `security.export.foreign_rows`) and
alert by email, with the API's server errors, database CPU and disk, and the worker or
PowerSync having no instance. The on-call runbook says what to do for each.

## Disaster recovery

- **Stance**: regional Cloud SQL (synchronous standby, automatic failover) plus point-in-time
  recovery, versioned buckets with a locked audit archive in prod, and the mobile app's offline
  mode as the business-continuity path. No cross-region copy: personal data stays in London.
- **Targets**: RPO 15 minutes, RTO 4 hours.
- **Restore outline** (`docs/runbooks/restore.md`, drilled quarterly): clone the instance to a
  point in time (`gcloud sql instances clone ... --point-in-time`), move state to the clone
  (`terraform state rm` and `terraform import`) or swap names, run
  `seed-secrets.sh <env> --refresh-urls` if the private IP changed, and deploy new revisions of
  api, worker and powersync. The sync-storage database never needs restoring: PowerSync
  rebuilds it.

## Local development

```sh
docker compose up -d postgres            # Postgres 17 + pgAudit, superuser harbour_admin
pnpm db:bootstrap && pnpm db:migrate     # roles, harbour database, schema, powersync publication
docker compose up -d                     # adds powersync-storage, powersync and mailpit
docker compose --profile flagsmith up -d # optional Flagsmith on http://localhost:8000
```

Ports are bound to 127.0.0.1: Postgres 5432, PowerSync bucket storage 5433, PowerSync 8080,
Mailpit SMTP 1025 and UI 8025.

## Checks to run before a pull request

```sh
cd infra
terraform fmt -check -recursive
for env in dev staging prod; do terraform -chdir=envs/$env init -backend=false -lockfile=readonly && terraform -chdir=envs/$env validate; done
(cd modules/harbour_stack && terraform init -backend=false && terraform test)
tflint --init --config "$PWD/.tflint.hcl" && for env in dev staging prod; do tflint --chdir=envs/$env --config "$PWD/.tflint.hcl"; done
trivy config --severity HIGH,CRITICAL .
```

## OpenTofu

The code uses nothing Terraform-only: `backend "gcs"`, `check` blocks and `mock_provider`
tests (OpenTofu 1.8+). The committed `.terraform.lock.hcl` files record `registry.terraform.io`
providers; on first `tofu init`, OpenTofu adds entries for `registry.opentofu.org`.

## Cost notes (dev)

Dev trades resilience for cost: zonal databases on small tiers, api and web scaling to zero, and
no NAT. The largest fixed costs are the two Cloud SQL instances, the always-on worker and
PowerSync, and the load balancer's forwarding rules. The `budget` module alerts at 50, 80 and
100 per cent of `budget_monthly_limit` and on the month-end forecast.
