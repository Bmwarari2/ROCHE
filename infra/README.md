# Harbour infrastructure

Terraform (OpenTofu-compatible) for Harbour's AWS environments, and the local Docker Compose
stack. Everything that stores or processes personal data runs in **AWS eu-west-2 (London)**.

```
infra/
  modules/
    harbour_stack/    the whole platform for one environment, composed from the modules below
    network/          VPC over eu-west-2a/b/c: public, private and isolated data subnets, NAT,
                      flow logs, S3 gateway endpoint, interface endpoints
    kms/              customer-managed keys per purpose (rds, s3, logs, secrets, ecr, alerts)
    rds_postgres/     Postgres 17 with pgAudit, IAM auth, Multi-AZ, PITR (used twice)
    s3_bucket/        private bucket: SSE-KMS, versioning, TLS-only policy, access logs
    ecs_service/      Fargate service or task definition, hardened container, autoscaling
    alb/              HTTPS-only load balancer with WAF and access logs
    cloudfront/       CDN for the web tier (origin: the ALB)
    waf/              AWS managed rule groups and a per-IP rate limit; blocks answer as JSON
                      problems (403 edge_blocked, 429 rate_limited with Retry-After)
    ecr/              immutable, scanned, KMS-encrypted image repositories
    acm_certificate/  DNS-validated certificates
    ses/              SES domain identity with DKIM and a configuration set
    observability/    CloudWatch alarms and the SNS alert topic
    budget/           monthly cost budget
    github_oidc/      GitHub Actions OIDC provider, plan role and deploy role
  envs/
    dev/ staging/ prod/   thin root modules: providers, backend and sizing only
  powersync/powersync.yaml      PowerSync config shared by Compose and ECS
  docker/postgres/              local Postgres 17 image with pgAudit
  scripts/seed-secrets.sh       generates secret values inside AWS
  scripts/ci-terraform-env.sh   CI helper for backend config and inputs
```

Each environment lives in its own AWS account (dev, staging, prod). The three `envs/` roots
call the same `harbour_stack` module, so staging rehearses exactly what prod will run.

## What runs in each environment

| Host | Served by | Notes |
| --- | --- | --- |
| `app.<domain>` | CloudFront, then ALB, then `web` (Next.js, port 3000) | Only reachable through CloudFront: the ALB rule requires a secret origin header |
| `api.<domain>` | ALB, then `api` (Hono, port 4000) | Also serves `/v1/sync/jwks` for PowerSync |
| `sync.<domain>` | ALB, then `powersync` (port 8080) | Self-hosted PowerSync, unified mode |
| `flags.<domain>` | ALB, then `flagsmith` (port 8000) | Optional, `enable_flagsmith = false` by default |
| none | `worker` | pg-boss jobs; same image as `api` with another command |
| none | `migrate` task definition | One-off `db:bootstrap` and migrations, run by the deploy workflow |

Data: RDS `harbour-<env>-main` (Postgres 17, logical replication for PowerSync) and
`harbour-<env>-sync-storage` (PowerSync bucket storage); S3 buckets for documents, exports,
the Object Lock audit archive and access logs.

## Residency rules

- Personal data is stored and processed only in eu-west-2. The provider blocks of every
  environment are pinned to eu-west-2 by a validation rule, and the stack has a check that
  fails loudly if it is ever pointed elsewhere.
- The only resources in us-east-1 are the CloudFront ACM certificate and the CLOUDFRONT-scope
  WAF web ACL, because AWS requires them there. Neither stores personal data: request sampling
  and WAF logging are off for that web ACL, so only aggregate request counts are kept.
- CloudFront terminates TLS at edge locations, some outside the UK. Dynamic responses use the
  managed CachingDisabled policy and are never stored at the edge; only immutable static
  assets (JavaScript, CSS, fonts, icons) are cached. Edge access logs are off (they would be
  written from us-east-1 with client IP addresses); the ALB logs requests in London.
- No cross-region replication of anything: AWS has no second UK region.
- Never use Railway, Render or Hetzner (no UK region) or Cloudflare (its jurisdiction
  restriction has no UK option) for anything that holds personal data. Vercel `lhr1` or
  Fly.io `lhr` may host only the stateless web tier, by ADR.
- The CI roles' guardrails deny every regional API call outside eu-west-2 (and us-east-1 for
  ACM and WAF only), so a mistaken change cannot create resources in another region.

## Bootstrap (once per AWS account, a human action)

Brian provisions the account and an administrator SSO role, then runs the following with
those credentials. Replace `<acct>` with the account ID. This is deliberately not Terraform,
so the state bucket never depends on the state it holds.

```sh
export AWS_REGION=eu-west-2 ACCT=<acct>

# 1. KMS key for state
KEY_ARN=$(aws kms create-key --description "Harbour Terraform state" \
  --query KeyMetadata.Arn --output text)
aws kms enable-key-rotation --key-id "$KEY_ARN"
aws kms create-alias --alias-name alias/harbour-tfstate --target-key-id "$KEY_ARN"

# 2. State bucket: versioned, SSE-KMS, private, TLS only
aws s3api create-bucket --bucket "harbour-tfstate-$ACCT" \
  --create-bucket-configuration LocationConstraint=eu-west-2
aws s3api put-bucket-versioning --bucket "harbour-tfstate-$ACCT" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "harbour-tfstate-$ACCT" \
  --server-side-encryption-configuration "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"$KEY_ARN\"},\"BucketKeyEnabled\":true}]}"
aws s3api put-public-access-block --bucket "harbour-tfstate-$ACCT" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-policy --bucket "harbour-tfstate-$ACCT" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"DenyInsecureTransport\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::harbour-tfstate-$ACCT\",\"arn:aws:s3:::harbour-tfstate-$ACCT/*\"],\"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"

# 3. Optional, only if you prefer DynamoDB locking to S3-native lock files
# aws dynamodb create-table --table-name harbour-tfstate-locks \
#   --attribute-definitions AttributeName=LockID,AttributeType=S \
#   --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST \
#   --sse-specification Enabled=true
echo "$KEY_ARN"
```

DNS: the simplest set-up is a Route 53 hosted zone for the environment's domain (for example
`dev.<product domain>`, delegated from the parent zone) in the same account. Pass its ID as
`route53_zone_id` and Terraform creates every record. Without it, the `manual_dns_records`
output lists the records to create by hand.

## First apply of dev (human, with administrator credentials)

```sh
cd infra/envs/dev
cp backend.hcl.example backend.hcl            # fill in bucket and kms_key_id
cp terraform.tfvars.example terraform.tfvars  # account ID, domain, zone, state bucket, mailboxes
terraform init -backend-config=backend.hcl
terraform apply
```

If the hosted zone is not in Route 53, apply the certificates first, create their validation
records, then apply everything:

```sh
terraform apply -target=module.stack.module.cert_regional -target=module.stack.module.cert_cloudfront
aws acm describe-certificate --certificate-arn <arn> --query 'Certificate.DomainValidationOptions[].ResourceRecord'
terraform apply
```

Then, once per environment:

1. **Mirror third-party images into ECR** (Fargate pulls only from the private registry):
   ```sh
   aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.eu-west-2.amazonaws.com
   crane copy journeyapps/powersync-service:1.26.1 <acct>.dkr.ecr.eu-west-2.amazonaws.com/harbour/powersync-service:1.26.1
   # only if enable_flagsmith = true
   crane copy flagsmith/flagsmith:2.280.0 <acct>.dkr.ecr.eu-west-2.amazonaws.com/harbour/flagsmith:2.280.0
   ```
2. **Seed secrets**: `infra/scripts/seed-secrets.sh dev`. Values are generated inside AWS; no
   password is ever in Terraform state, plan output or the repository.
3. **Bootstrap and migrate the databases**: run the `migrate` task (the `migrate_task`
   output has the task definition, subnets and security group):
   ```sh
   aws ecs run-task --cluster harbour-dev --task-definition harbour-dev-migrate --launch-type FARGATE \
     --network-configuration 'awsvpcConfiguration={subnets=[subnet-...],securityGroups=[sg-...],assignPublicIp=DISABLED}'
   ```
   On the bucket-storage instance the bootstrap must also run, as `SYNC_STORAGE_ADMIN_USER`:
   `CREATE ROLE powersync_storage LOGIN PASSWORD '<HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE>';`
   `GRANT CREATE ON DATABASE powersync_storage TO powersync_storage;` (PowerSync creates its
   own schema). With Flagsmith enabled, also create role and database `flagsmith` there.
4. **Hand over to CI**: store `terraform output -raw deploy_role_arn` as the repository secret
   `AWS_DEPLOY_ROLE_ARN` and `plan_role_arn` as `AWS_PLAN_ROLE_ARN`, and set the repository
   variables `AWS_DEV_ACCOUNT_ID`, `DEV_DOMAIN_NAME`, `TF_STATE_BUCKET_DEV`, and optionally
   `TF_STATE_KMS_KEY_ARN_DEV`, `DEV_ROUTE53_ZONE_ID`, `DEV_ALERT_EMAILS` and
   `DEV_BUDGET_EMAILS` (JSON lists, for example `["platform-alerts@example.invalid"]`).
5. **Confirm the alert subscriptions** (SNS sends a confirmation email to each mailbox).
6. **SES production access** (human): SES starts in the sandbox. Request production access for
   eu-west-2 in the SES console, describing transactional email only (sign-in, invitations,
   rota and compliance notifications), with bounce and complaint handling by suppression list.

## How OIDC deploys work

`.github/workflows/terraform.yml` assumes AWS roles with GitHub's OIDC token; there are no
long-lived AWS keys anywhere.

| Role | Trusted subject | Can do |
| --- | --- | --- |
| `harbour-<env>-github-plan` | `repo:Bmwarari2/ROCHE:pull_request` | Read configuration (`ReadOnlyAccess`), read and lock state |
| `harbour-<env>-github-deploy` | `repo:Bmwarari2/ROCHE:ref:refs/heads/main` | Change the services the stack uses; IAM only for `harbour-*`; S3, ECR, secrets and SSM only for Harbour-named resources |

Both roles carry a guardrails policy of explicit denies: no `secretsmanager:GetSecretValue`,
no reading S3 objects other than state, no reading log events, no `rds-db:connect`, no IAM
users or access keys, and no regional API calls outside London. Forked pull requests get no
OIDC token. Jobs must not declare a GitHub `environment:`, because that changes the token
subject to `environment:<name>`, which neither role trusts.

On a pull request touching `infra/**` the workflow runs `fmt`, `init -backend=false` and
`validate` for dev, staging and prod, `terraform test` (the whole stack planned against mocked
providers), TFLint with the AWS ruleset, and a Trivy configuration scan that fails on HIGH or
CRITICAL findings. If `AWS_DEPLOY_ROLE_ARN` exists it also plans dev with the plan role and
posts the plan to the pull request. On a push to main it plans and applies dev with the deploy
role. Staging and prod applies are not automated yet: they follow the release process
(tagged candidates; prod on a signed tag after Brian's approval).

### Application releases

Image tags are immutable and should be the commit SHA. For each release the deploy workflow
(with the deploy role) should:

1. build and push `harbour/api` and `harbour/web`;
2. `aws ssm put-parameter --overwrite --name /harbour/<env>/release/api --value <sha>` (and `web`);
3. `terraform apply` in `infra/envs/<env>`, which registers new task definitions (the worker
   and the migrate task follow the api tag);
4. run the `migrate` task and wait for it to succeed before the new tasks take traffic
   (expand-and-contract migrations keep the previous version working meanwhile).

Terraform reads the release pointers but never resets them, so an infrastructure-only change
cannot roll an application back. `image_tags` overrides a pointer for one apply.

## Runtime contract for application images

| | api and worker | web |
| --- | --- | --- |
| Command | `node apps/api/dist/server.js`, `node apps/api/dist/worker.js` | image default |
| Port and health check | 4000, `GET /health` | 3000, `GET /api/health` |
| User, filesystem | uid 1000; read-only root, writable `/tmp` | uid 1000; writable `/tmp` and `/app/apps/web/.next/cache` |
| CA bundle | AWS RDS global bundle at `/app/certs/rds-global-bundle.pem` (set as `NODE_EXTRA_CA_CERTS`) | none |

API and worker environment: `NODE_ENV`, `HARBOUR_ENV`, `APP_VERSION`, `AWS_REGION`,
`BETTER_AUTH_URL`, `WEB_ORIGINS`, `PASSKEY_RP_ID`, `TRUSTED_PROXY_CIDRS` (the VPC range, so
sign-in throttling counts each client address rather than one shared bucket), `POWERSYNC_URL`,
`SYNC_JWT_AUDIENCE` (`harbour-powersync`), `S3_DOCUMENTS_BUCKET`, `S3_EXPORTS_BUCKET`,
`S3_AUDIT_ARCHIVE_BUCKET`, `SES_CONFIGURATION_SET`, `EMAIL_FROM_DOMAIN`. Secrets:
`DATABASE_APP_URL`, `DATABASE_AUTH_URL`, `DATABASE_OPERATOR_URL`, `DATABASE_WORKER_URL` (the API
refuses to start in production without any of the four), `BETTER_AUTH_SECRET`,
`SYNC_SIGNING_KEY_PEM`, `SYNC_SIGNING_KEY_ID`,
`HARBOUR_DB_PASSWORD_HARBOUR_APP`, `HARBOUR_DB_PASSWORD_HARBOUR_AUTH`,
`HARBOUR_DB_PASSWORD_HARBOUR_WORKER`.

Migrate task: `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_SSL_MODE`,
`DATABASE_ADMIN_USER` and `DATABASE_ADMIN_PASSWORD` (the RDS master user, as parts because
RDS rotates the password and it may contain characters reserved in URLs; build
`DATABASE_ADMIN_URL` from them when it is unset), `DATABASE_OWNER_URL`,
`HARBOUR_DB_PASSWORD_<ROLE>` for every login role, and `SYNC_STORAGE_HOST`, `SYNC_STORAGE_PORT`,
`SYNC_STORAGE_DATABASE`, `SYNC_STORAGE_ADMIN_USER`, `SYNC_STORAGE_ADMIN_PASSWORD`,
`HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE` for the bucket-storage instance.

PowerSync replicates as `harbour_sync` from the `powersync` publication (migration 0002) and
verifies client JWTs (audience `harbour-powersync`) against `https://api.<domain>/v1/sync/jwks`.

## Database settings

Both RDS instances: Postgres 17, gp3 storage encrypted with the `rds` key, Multi-AZ by
default, IAM database authentication, deletion protection, 35 days of backups and
point-in-time recovery, Performance Insights encrypted with the `rds` key, enhanced
monitoring, `postgresql` and `upgrade` logs exported to KMS-encrypted log groups, master
password managed by RDS in Secrets Manager, no public access, and a parameter group with:

- `shared_preload_libraries = pgaudit,pg_stat_statements`
- `pgaudit.log = ddl,role,write`, `pgaudit.log_relation = 1`, `pgaudit.log_parameter = 0`
- `rds.logical_replication = 1` (main database only, for PowerSync), `max_slot_wal_keep_size`
- `rds.force_ssl = 1`, `ssl_min_protocol_version = TLSv1.2`
- `log_connections = 1`, `log_disconnections = 1`, `password_encryption = scram-sha-256`

**Why pgAudit does not log `read`.** Section 5.5 requires every view of a care record to be
audited, and the application does that in `audit_event` with the actor, role, tenant, device
and reason. pgAudit cannot add any of that, because every request reaches Postgres as the same
application role. Logging every SELECT (including PowerSync snapshots and RLS-filtered lists)
would multiply log volume and cost and bury the DDL, privilege and write events the database
log exists to make tamper-evident, and read statements carry search terms and filter literals,
the most likely place for personal data to leak into logs. `pgaudit.log_parameter` is off, so
bound values never reach CloudWatch either.

## Disaster recovery

- **Stance**: Multi-AZ RDS (synchronous standby, automatic failover) plus point-in-time
  recovery for 35 days, versioned S3 with an Object Lock audit archive, and the mobile app's
  offline mode as the business-continuity path. AWS has no second UK region, so there is no
  cross-region copy (recorded in ADR-0001).
- **Targets**: RPO 15 minutes (RDS uploads transaction logs every 5 minutes), RTO 4 hours.
- **Restore outline** (full runbook belongs in `docs/runbooks/restore.md`, drilled quarterly):
  restore the instance to a point in time as a new identifier; rename the damaged instance
  aside and the restored one to `harbour-<env>-main`, or update state with `terraform state rm`
  and `terraform import`; run `seed-secrets.sh <env> --refresh-urls` if the endpoint changed;
  force new deployments of api, worker and powersync; PowerSync re-snapshots its bucket
  storage on its own. The sync-storage database never needs restoring: it can be rebuilt.

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

## Checks to run before a pull request

```sh
cd infra
terraform fmt -check -recursive
for env in dev staging prod; do terraform -chdir=envs/$env init -backend=false && terraform -chdir=envs/$env validate; done
(cd modules/harbour_stack && terraform init -backend=false && terraform test)
tflint --init --config "$PWD/.tflint.hcl" && for env in dev staging prod; do tflint --chdir=envs/$env --config "$PWD/.tflint.hcl"; done
trivy config --severity HIGH,CRITICAL .
```

## OpenTofu

The code uses nothing Terraform-only: `backend "s3"` with `use_lockfile` (OpenTofu 1.10+),
`check` blocks, provider aliases and `mock_provider` tests (OpenTofu 1.8+). The committed
`.terraform.lock.hcl` files record `registry.terraform.io` providers; on first `tofu init`,
OpenTofu adds entries for `registry.opentofu.org`. Commit that change if the team switches.

## Cost notes (dev)

Dev trades resilience for cost: one NAT gateway, single-AZ databases, interface endpoints in
one zone (six services) and Fargate Spot. The largest fixed costs are the two RDS instances,
the NAT gateway, the interface endpoints and the ALB. The `budget` module alerts at 50, 80 and
100 per cent of `budget_monthly_limit` and on the month-end forecast.
