# Infrastructure on Google Cloud, europe-west2

Branch `feat/infra-google-cloud`. The owner decided on 31/10/2026 to move production from AWS to
Google Cloud; ADR-0098 (on `docs/production-google-cloud`) records it. Nothing is deployed: there
are no Google Cloud credentials, so the code is validated and tested only.

## What changed

- `infra/modules`: the AWS modules are removed (no dual stack). New modules: `project_baseline`
  (APIs; `gcp.resourceLocations` set to `in:europe-west2-locations`; no service account keys;
  audit logs including Data Access), `network` (VPC, Direct VPC egress subnet with flow logs,
  private services access for Cloud SQL, optional Cloud NAT), `kms` (key ring and keys, rotated
  every 90 days), `cloud_sql_postgres` (PostgreSQL 17, regional HA, point-in-time recovery,
  private IP only, encrypted connections only, CMEK, `cloudsql.enable_pgaudit` and
  `cloudsql.logical_decoding`, backups in europe-west2), `cloud_run_service` (service or job,
  min and max instances, sidecars, Secret Manager secrets as variables or files, one service
  account each, ingress internal or internal-and-load-balancer only), `gcs_bucket` (CMEK,
  uniform access, public access prevention, versioning, optional lockable retention),
  `secret_manager` (regional secrets created empty), `artifact_registry`, `load_balancer`
  (external HTTPS load balancer, Certificate Manager, Cloud Armor with the OWASP CRS
  preconfigured rules at pinned versions and a rate limit, Cloud CDN for the web tier's static
  files), `dns`, `observability` (security log bucket kept 400 days, locked in prod; worker event
  metrics and alerts), `github_wif` (Workload Identity Federation for this repository only) and
  `budget`.
- `harbour_stack` wires the API (with ClamAV beside it on 127.0.0.1:3310), the worker, PowerSync
  (always one instance), the web tier, optional Flagsmith and the migration job. The audit
  archive's 365-day retention lock is on in prod only, and a lock elsewhere fails the plan. A
  prod plan fails until every Cloud Armor rule is pinned. Email is an SMTP variable.
- `dev`, `staging` and `prod` use the `gcs` backend; lock files are regenerated.
- `.github/workflows/terraform.yml`: `google-github-actions/auth` through Workload Identity
  Federation (plan account for pull requests, deploy account for main), and a release job that
  builds and pushes the api and web images to Artifact Registry, runs the migration job and
  releases the services, all gated until the repository variables exist. tflint uses the Google
  ruleset.
- `infra/scripts/seed-secrets.sh` and `ci-terraform-env.sh` rewritten for Google Cloud;
  `infra/README.md` gives the bootstrap (project, state bucket, Workload Identity Federation,
  secrets, first apply, migrations as a Cloud Run job).

## What is next

- Wired to the application settings of `feat/api-google-cloud-adapters`: no CA in the image (the
  Cloud SQL server CA is mounted from Secret Manager at `/secrets/cloudsql/server-ca.pem` for the
  API, worker, migrate job and PowerSync, with `NODE_EXTRA_CA_CERTS`), `DOCUMENT_STORAGE=gcs`,
  `GCP_PROJECT_ID`, `GCS_DOCUMENTS_BUCKET`, `GCS_EXPORTS_BUCKET`, `GCS_KMS_KEY`, and SMTP
  (`SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`; `SMTP_USER` and `SMTP_PASSWORD` from Secret Manager)
  left unset until a provider is chosen. No signed URLs, so no CORS and no token creator grant.
- Cloud Armor answers a block with its own page, not the old `edge_blocked` JSON problem. Devices
  are still safe (they end a session only on a 401 or a session code); a custom error response
  on the load balancer would restore the JSON body.
- Confirm that Cloud Run reads regional Secret Manager secrets as variables and files; if not,
  switch `secret_manager` to global secrets with user-managed replication in europe-west2.
- Create the `pgaudit` extension in `db:bootstrap`.
- Update the restore and on-call runbooks and the Cyber Essentials and ISO 27001 evidence, which
  still cite the AWS modules, and the mobile comment that names `infra/modules/waf`.
- Human actions: create the three projects and run the bootstrap, set the organisation's log
  storage location, pin the Cloud Armor rule versions for prod (as H-140 did for AWS WAF), choose
  and register the SMTP provider.

## Tests

- `terraform fmt -check -recursive`; `terraform validate` for dev, staging and prod with
  `-lockfile=readonly`; `terraform test` in `modules/harbour_stack`: 12 runs passing (London
  only, another region refused, keys rotate, nothing public, services and databases (the CA
  mounted, documents and exports apart, no SMTP until chosen), Flagsmith
  and Cloud DNS, the audit lock only in prod, prod refused without every Cloud Armor pin, prod).
- tflint and Trivy were not run locally (installing them was not allowed here); CI runs both.
