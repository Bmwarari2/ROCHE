# Harbour infrastructure

Terraform (OpenTofu-compatible) for Harbour's Google Cloud environments, and the local Docker
Compose stack. Everything that stores or processes personal data runs in **Google Cloud
europe-west2 (London)** (ADR-0098, which replaces the AWS eu-west-2 choice in ADR-0001).

```
infra/
  modules/
    harbour_stack/      the whole platform for one environment, composed from the modules below
    project_baseline/   APIs and the CMEK service agents
    network/            VPC, the Cloud Run subnet (Direct VPC egress, flow logs), private
                        services access for Cloud SQL, Cloud NAT with static addresses
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
    github_wif/         Workload Identity Federation for this repository's Terraform workflow,
                        plan, apply and release accounts, the CI deny policy (no JSON keys)
    budget/             monthly budget in pounds
  bootstrap/            applied by a person, never CI: project IAM (Data Access audit logs),
                        organisation policies, folder log location, GitHub federation and
                        the CI deny policy
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
| `app.<domain>` | load balancer (Cloud Armor), then `web` (Next.js, port 3000) | `/_next/static/*` only goes through a separate backend with Cloud CDN; pages never do |
| `api.<domain>` | load balancer (Cloud Armor), then `api` (Hono, port 4000) with a ClamAV sidecar on 127.0.0.1:3310 | Also serves `/v1/sync/jwks` for PowerSync |
| `learn.<elearning_domain_name>` | load balancer (Cloud Armor), then `web`, on its own backend and its own Certificate Manager certificate | The e-learning content origin (ADR-0093), on its own registrable domain (`elearning_domain_name`, never `<domain>` or under it, so package script is another site from the app; security review H1). Only `/learn/*` is forwarded; Cloud Armor answers any other path on this host with a fixed 404 (M4). Its backend adds no X-Frame-Options (the app frames the runtime page) and sends `Referrer-Policy: no-referrer`. DNS in `elearning_dns_zone_name`, or listed in `manual_elearning_dns_records`; `ELEARNING_ORIGIN` on the web service. Unset, courses do not launch |
| `sync.<domain>` | load balancer (Cloud Armor), then `powersync` (port 8080) | Self-hosted PowerSync, unified mode, always one instance; `/api/admin` is refused at the edge |
| `flags.<domain>` | load balancer (Cloud Armor), then `flagsmith` (port 8000) | Optional, `enable_flagsmith = false` by default; only Harbour's NAT addresses and `flags_admin_ranges` reach it |
| none | `worker` | pg-boss jobs; same image as `api`; internal ingress; CPU always allocated |
| none | `migrate` Cloud Run job | `db:bootstrap` and migrations, run by the release job |

Every Cloud Run service with a host has ingress `internal-and-cloud-load-balancing`, so it can
be reached only through the load balancer and Cloud Armor; the worker's ingress is internal.
Every service sends all its traffic through the VPC: Cloud SQL by private IP, the internet
through Cloud NAT's static addresses. The web tier calls the API through the load balancer from
those addresses, so the API trusts them as proxies (sign-in throttling counts each person) and
Cloud Armor does not rate limit them as one client.

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
- Log storage: the bootstrap sets the folder's log location to London with no `_Default` sink,
  before the projects are created, so `_Required` is in London too; Harbour's sinks route audit,
  pgAudit and application logs to its own London buckets, encrypted with the project's key.
- No cross-region copy of anything.
- Email has no Google Cloud service: an SMTP provider (H-08), on the sub-processor register and
  in the DPIA, set with the `smtp` variable and the `smtp-user` and `smtp-password` secrets.
- Never use Railway, Render or Hetzner (no UK region) or Cloudflare (its jurisdiction
  restriction has no UK option) for anything that holds personal data.

## Bootstrap (a human action, in this order)

Brian, with an organisation administrator account (H-04, broken down as H-1090 to H-1095 in
`docs/plans/human-actions.md`). **Order matters**: a folder's log storage
location applies only to projects created after it is set.

```sh
# 1. Once (H-1090): a folder for Harbour whose projects store logs in London and get no _Default sink.
#    (infra/bootstrap sets this with folder_id; by hand:)
gcloud logging settings update --folder=<folder-id> --storage-location=europe-west2 --disable-default-sink

# 2. Once (H-1091): a separate state project and bucket (versioned, London, uniform access, public access
#    prevented). State lives outside the environments, so their deny policies never stop CI
#    reading it.
gcloud projects create harbour-state-<suffix> --folder=<folder-id>
gcloud storage buckets create gs://harbour-tfstate-harbour-state-<suffix> --project harbour-state-<suffix> \
  --location=europe-west2 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://harbour-tfstate-harbour-state-<suffix> --versioning

# 3. Per environment (H-1092): the project, in the folder, linked to billing.
ENV=dev
PROJECT=harbour-${ENV}-<suffix>
gcloud projects create "${PROJECT}" --folder=<folder-id>
gcloud billing projects link "${PROJECT}" --billing-account=<billing-account-id>
gcloud services enable --project "${PROJECT}" cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  orgpolicy.googleapis.com logging.googleapis.com

# 4. Per environment (H-1093): infra/bootstrap, as the administrator (organisation policy, IAM
#    and deny policy rights). It sets gcp.resourceLocations and the no-key policy, turns on Data
#    Access audit logs for every service, creates Workload
#    Identity Federation for this repository's Terraform workflow only (by numeric repository
#    and owner ids: gh api repos/Bmwarari2/ROCHE --jq '.id, .owner.id'), the plan, apply and
#    release accounts, and the deny policy that keeps them from secret values, data and logs.
cd infra/bootstrap
terraform init -backend-config=backend.hcl     # prefix bootstrap/<env>
terraform apply -var-file=${ENV}.tfvars
```

For a project created before step 1, disable its default sink by hand:
`gcloud logging sinks update _Default --disabled --project "${PROJECT}"`. The `_Required` bucket
(Admin Activity audit logs, held by Google for 400 days) stays global for such a project; create
projects after step 1 so it is in London.

Then, in GitHub (H-1094), create the environments the bootstrap's `subjects` output names
(`<env>-plan`, `<env>`, `<env>-release`) and protect them: deployment branch `main` for `<env>`
and `<env>-release`, required reviewers for staging and prod. Copy
`envs/${ENV}/backend.hcl.example` to `backend.hcl` and `terraform.tfvars.example` to
`terraform.tfvars`, and fill them in. GCS locks state natively.

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
2. **Images** (H-06, H-16). Copy the ClamAV image into the registry (`<registry>/clamav:<clamav_version>`),
   and the PowerSync and, if used, Flagsmith images, then push the first api and web images
   (the release job does this from then on).
3. **Secrets** (H-07). `GCP_PROJECT_ID=${PROJECT} infra/scripts/seed-secrets.sh ${ENV}`. Add the
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
Identity Federation, set up by a person in `infra/bootstrap` (CI cannot change it). The pool's
provider accepts tokens only from this repository's Terraform workflow, by numeric repository
and owner ids, and each account trusts one GitHub environment of its own Google Cloud
environment:

| Account | Trusts | Can |
| --- | --- | --- |
| `harbour-<env>-gh-plan` | `environment:<env>-plan` (pull requests from this repository, never forks) | read the project's configuration and state |
| `harbour-<env>-gh-deploy` | `environment:<env>` | apply the stack; no basic roles and no project IAM (the stack grants only on resources), organisation policy, federation or deny policies |
| `harbour-<env>-gh-release` | `environment:<env>-release` | push images, update and run the migration job, release new revisions, acting as the runtime accounts only |

A deny policy on each project stops all three reading secret values, objects (care documents,
exports, the audit archive), logs or database exports, creating keys or changing the federation,
whatever roles they hold. Service account keys are also blocked by organisation policy. If the
deny policy API refuses a permission as not supported for deny, remove it from the list and
record the gap in an ADR.

Repository variables (Settings, Secrets and variables, Actions, Variables), per environment:
`GCP_PROJECT_ID_DEV`, `GCP_WORKLOAD_IDENTITY_PROVIDER_DEV`, `GCP_PLAN_SERVICE_ACCOUNT_DEV`,
`GCP_DEPLOY_SERVICE_ACCOUNT_DEV`, `GCP_RELEASE_SERVICE_ACCOUNT_DEV` (bootstrap outputs),
`TF_STATE_BUCKET_DEV`, `DEV_DOMAIN_NAME`, and optionally `DEV_DNS_ZONE_NAME`, `DEV_ALERT_EMAILS`
(a JSON list) and `GCP_BILLING_ACCOUNT_ID`. Until the provider and deploy account are set, the
plan, apply and release jobs skip with a notice.

### Application releases

The `release-dev` job builds the api and web images before it signs in (so no credential is in the
build context while dependencies install), signs in as the release account without writing a
credentials file, pushes the images to Artifact Registry tagged with the commit SHA (tags are
immutable), updates and executes the migration job with the new api image, then releases api,
worker and web. Terraform ignores the services' images after the first
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
Google's front ends and the NAT addresses), `POWERSYNC_URL`, `SYNC_JWT_AUDIENCE`,
`DOCUMENT_STORAGE=gcs`, `GCS_DOCUMENTS_BUCKET` and `GCS_EXPORTS_BUCKET` (two different buckets),
`GCS_KMS_KEY` (the `storage` key in europe-west2), `GCS_AUDIT_ARCHIVE_BUCKET`,
`MALWARE_SCANNER=clamd`, `CLAMD_HOST=127.0.0.1`, `CLAMD_PORT=3310`, `EMAIL_FROM_DOMAIN`,
`SSO_KEY_STORE=gcp`, `SAFETY_CASE_VERSION`, and, once an email provider is chosen, `SMTP_HOST`,
`SMTP_PORT` and `SMTP_TLS` (unset until then). Secrets (each a whole secret version):
`DATABASE_APP_URL`, `DATABASE_AUTH_URL`, `DATABASE_OPERATOR_URL`, `DATABASE_WORKER_URL`,
`BETTER_AUTH_SECRET`, `EVIDENCE_LINK_SECRET`, `ELEARNING_LAUNCH_SECRET` (the e-learning launch token key, ADR-0093, from `api-elearning-launch-secret`; refused in production if unset; an environment seeded before slice 43 needs that secret seeded, H-1011), `SPEAK_UP_THROTTLE_SECRET` (keys the network hash
in the public speak-up limits, ADR-0089; refused in production if unset), `SYNC_SIGNING_KEY_PEM`,
`SYNC_SIGNING_KEY_ID`, `HARBOUR_DB_PASSWORD_HARBOUR_APP`, `HARBOUR_DB_PASSWORD_HARBOUR_AUTH`,
`HARBOUR_DB_PASSWORD_HARBOUR_WORKER`, and `SMTP_USER` and `SMTP_PASSWORD` with the provider.
Downloads stream through the API: no signed URLs, so the buckets allow no public or signed
access and need no CORS.

Single sign-on keys (ADR-0091) are not Terraform's: each organisation's private key is a regional
secret in the environment's project, named `harbour_sso_<tenant id>_<name>` (the store name
`harbour/sso/<tenant id>/<name>` with `_` for `/`, since secret ids take no slashes), encrypted
with the `secrets` key. Thapsus adds it and grants the API's service account
`roles/secretmanager.secretAccessor` and `roles/secretmanager.viewer` on that secret only (H-751);
the API reads it through the europe-west2 endpoint at sign-in, and a key it may not read counts as
missing.

Migrate job: `DATABASE_HOST` (private IP), `DATABASE_PORT`, `DATABASE_NAME`,
`DATABASE_SSL_MODE=verify-ca`, `DATABASE_ADMIN_USER=postgres`, `DATABASE_ADMIN_PASSWORD`,
`DATABASE_OWNER_URL`, `HARBOUR_DB_PASSWORD_<ROLE>` for every login role, and
`SYNC_STORAGE_HOST`, `SYNC_STORAGE_PORT`, `SYNC_STORAGE_DATABASE`, `SYNC_STORAGE_ADMIN_USER`,
`SYNC_STORAGE_ADMIN_PASSWORD`, `HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE`.

PowerSync replicates as `harbour_sync` from the `powersync` publication (migration 0002) and
verifies client tokens against `https://api.<domain>/v1/sync/jwks`.

## Edge blocks

Cloud Armor answers a WAF block with 403 and its own HTML page, and the rate limit with 429; it
cannot send the JSON problem body (`edge_blocked`) the AWS WAF did. A load balancer custom error
response could swap the body, but it cannot tell Cloud Armor's 403 from the API's own 403
problems (`step_up_required`, `device_revoked` and the session codes), and would overwrite them,
so it is not used. Devices already tell an edge block apart: a 403 whose problem `code` is one of
the API's session codes ends the session; any other 403 (no body, an HTML page, or a JSON
`edge_blocked`) makes the device ask `GET /v1/me` whether the session stands before it does
anything, and keeps unsent entries queued (`apps/mobile/src/sync/connector.ts`, tested with an
HTML 403 page). Prod pins every preconfigured rule (H-1095, the Google Cloud form of H-140).

## Database settings

Both Cloud SQL instances: PostgreSQL 17, SSD storage and backups encrypted with the `sql` key,
regional availability by default (a synchronous standby in a second zone with automatic
failover), deletion protection, automated backups in europe-west2 with point-in-time recovery
(7 days on Enterprise, 35 on Enterprise Plus in prod), private IP only, encrypted connections
only, Query Insights without client addresses, a password policy, and flags:

- `cloudsql.enable_pgaudit = on`, `pgaudit.log = ddl,role,write`, `pgaudit.log_parameter = off`,
  `pgaudit.log_relation = on`, `pgaudit.log_catalog = off`
- `log_error_verbosity = terse` (error lines never carry a duplicate key's values)
- `cloudsql.logical_decoding = on` (main instance only, for PowerSync)
- `log_connections`, `log_disconnections`, `log_checkpoints`, `log_lock_waits` on,
  `log_temp_files = 0`, `log_min_duration_statement = -1`

Roles and passwords are created by `pnpm db:bootstrap` from the secrets, never by Terraform.
The flag makes pgAudit available; `db:bootstrap` (run by the migration job) then creates the
extension in the harbour database, and in production refuses to continue if the flag is off.

**Why pgAudit does not log `read`.** Section 5.5 requires every view of a care record to be
audited, and the application does that in `audit_event` with the actor, role, tenant, device
and reason. pgAudit cannot add any of that, because every request reaches Postgres as the same
application role. Logging every SELECT would multiply log volume and cost and bury the DDL,
privilege and write events the database log exists to make tamper-evident, and read
statements carry search terms and filter literals, the most likely place for personal data to
leak into logs. `pgaudit.log_parameter` is off, so bound values never reach Cloud Logging.

## Logs and alerts

Audit logs (Admin Activity and Data Access for every service), pgAudit and database connection
logs, and Cloud Armor requests go to the `harbour-<env>-security` bucket in europe-west2, kept
400 days or more and locked in prod; other Cloud Run and Cloud SQL logs to `harbour-<env>-app`
(30 days). Both are encrypted with the project's `logs` key. Log-based metrics read the worker's structured
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
for root in bootstrap envs/dev envs/staging envs/prod; do terraform -chdir=$root init -backend=false -lockfile=readonly && terraform -chdir=$root validate; done
for dir in modules/harbour_stack modules/github_wif bootstrap; do (cd $dir && terraform init -backend=false && terraform test); done
tflint --init --config "$PWD/.tflint.hcl" && for root in bootstrap envs/dev envs/staging envs/prod; do tflint --chdir=$root --config "$PWD/.tflint.hcl"; done
trivy config --severity HIGH,CRITICAL .
```

## OpenTofu

The code uses nothing Terraform-only: `backend "gcs"`, `check` blocks and `mock_provider`
tests (OpenTofu 1.8+). The committed `.terraform.lock.hcl` files record `registry.terraform.io`
providers; on first `tofu init`, OpenTofu adds entries for `registry.opentofu.org`.

## Cost notes (dev)

Dev trades resilience for cost: zonal databases on small tiers and api and web scaling to zero. The largest fixed costs are the two Cloud SQL instances, the always-on worker and
PowerSync, and the load balancer's forwarding rules. The `budget` module alerts at 50, 80 and
100 per cent of `budget_monthly_limit` and on the month-end forecast.
