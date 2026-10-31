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

- Security review fixes: a new `infra/bootstrap` root, applied by a person, holds the
  organisation policies (split into the location policy and the key ban), the folder's log
  location in London with no `_Default` sink, and Workload Identity Federation. Each
  environment's plan, apply and release accounts trust one GitHub environment of that
  environment only (`<env>-plan`, `<env>`, `<env>-release`), the provider admits this
  repository's Terraform workflow only, by numeric repository and owner ids, and a deny policy
  keeps all three from secret values, objects, logs, database exports, keys and their own
  federation. The apply account holds no organisation policy or federation role, and a separate
  release account pushes images and acts as the runtime accounts only. State moves to a
  separate state project. The release job builds images before signing in and writes no
  credentials file (`gha-creds-*.json` is ignored by Git and Docker). Fork pull requests get no
  plan, and checkouts keep no credentials.
- Also from the review: pgAudit and connection logs go to the 400-day security bucket; both log
  buckets use a `logs` key; `log_error_verbosity = terse`, `pgaudit.log_relation` on and
  `pgaudit.log_catalog` off; all services egress through Cloud NAT static addresses, which the
  API trusts as proxies and Cloud Armor does not rate limit; PowerSync's `/api/admin` is refused
  at the edge and Flagsmith is allowlisted; Cloud CDN serves `/_next/static/*` only, on its own
  backend; SMTP must use TLS; security logs need 400 days and the prod audit archive 365.

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
- Human actions: set the folder's log location, create the state project and the three
  projects, apply `infra/bootstrap` per environment, create and protect the GitHub environments,
  pin the Cloud Armor rule versions for prod (as H-140 did for AWS WAF), choose and register the
  SMTP provider.
- Pin the workflow's actions and the Trivy image to commit SHAs and digests (the GitHub API was
  not reachable from here to look them up).
- The apply account still holds `resourcemanager.projectIamAdmin` and `iam.serviceAccountUser`
  at project level; replace them with a custom role and per-account grants, and confirm in the
  first apply that every denied permission is supported by deny policies.
- The ADR (ADR-0098), the constraints digest, the sub-processor register, the records of
  processing and the security checklist still name AWS; they belong to `docs/production-google-cloud`.

## Tests

- `terraform fmt -check -recursive`; `terraform validate` for bootstrap, dev, staging and prod
  with `-lockfile=readonly`; `terraform test`: `modules/github_wif` 4 runs and `bootstrap` 2 runs
  passing (each environment trusts its own GitHub environments only, by numeric ids; the deny
  policy; refused roles); `modules/harbour_stack` 16 runs passing (London
  only, another region refused, keys rotate, nothing public, services and databases (the CA
  mounted, documents and exports apart, no SMTP until chosen), Flagsmith
  and Cloud DNS, egress and edge rules, plaintext SMTP and short log retention refused, the audit
  lock only in prod, prod refused without every Cloud Armor pin or a year of audit archive, prod).
- tflint and Trivy were not run locally (installing them was not allowed here); CI runs both.
