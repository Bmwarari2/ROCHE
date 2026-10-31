---
status: "accepted"
date: 2026-10-31
decision-makers: Brian (owner, Thapsus Cargo Ltd)
consulted: engineering (Claude Code sessions), data protection lead (sub-processor and DPIA updates)
informed: CSO, DPO, advisers
---

# Production on Google Cloud europe-west2, and Brian's open decisions take their defaults

## Context and problem statement

Section 6 of the master prompt, [ADR-0001](0001-technology-stack.md) and
[ADR-0008](0008-production-hosting.md) place production on AWS eu-west-2 (London). On 31/10/2026
the owner decided that production runs on Google Cloud instead. The same day he decided that every
open decision he owns takes the default already in force. This ADR records both, the Google Cloud
target and what it replaces. It deviates from the master prompt (section 6 names AWS); the
constraints digest says such a deviation is recorded in an ADR, and this is that record. The master
prompt itself is left as the owner wrote it.

## Decision drivers

- The owner's instruction (31/10/2026): production on Google Cloud.
- UK residency of production personal data (master prompt section 5, ADR-0001): one UK region,
  enforced by policy, never by convention.
- Managed services over self-run infrastructure where they meet the security and audit rules
  (section 5.3 and 5.5): encryption with customer keys, private networking, immutable audit storage.
- Disaster recovery stays RPO 15 minutes and RTO 4 hours, with offline mobile as the continuity
  path (ADR-0001).
- No long-lived cloud credentials in CI or in Git.

## Considered options

- Google Cloud europe-west2 (London), managed services (Cloud Run, Cloud SQL, Cloud Storage).
- Google Cloud europe-west2 on GKE Autopilot for every service.
- Stay on AWS eu-west-2 (ADR-0001, ADR-0008).

## Decision outcome

Chosen option: "Google Cloud europe-west2, managed services", because it is what the owner decided
and it meets the residency, encryption, audit and recovery rules with the least infrastructure to
run. GKE Autopilot is kept as the fallback for PowerSync only if Cloud Run's streaming limits are
reached.

This ADR partly supersedes [ADR-0001](0001-technology-stack.md) (hosting, files, messaging and
infrastructure rows, the residency and disaster-recovery text),
[ADR-0008](0008-production-hosting.md) (production on AWS),
[ADR-0031](0031-document-storage-scanning-and-destruction.md) (S3, KMS and ClamAV on ECS),
[ADR-0060](0060-family-notification-channels.md) (Amazon SES), and every other ADR where it names an
AWS service. Supabase London for development, staging and pilots (ADR-0008) is unchanged.

### The production target (the default in force)

- **Region and residency**: europe-west2 (London) only. An organisation policy,
  `constraints/gcp.resourceLocations` set to `in:europe-west2-locations`, refuses any resource
  elsewhere. Multi-region and global resources that hold personal data are not used.
- **Compute**: Cloud Run for the API, the pg-boss worker and the PowerSync service, each with a
  minimum of 1 instance (no cold start at the point of care; the worker never scales to zero).
  ClamAV runs as a Cloud Run sidecar beside the API, reached on localhost. GKE Autopilot only if
  PowerSync's streaming connections reach Cloud Run's limits. The web tier runs on Cloud Run too;
  Vercel `lhr1` and Fly.io `lhr` stay allowed for the stateless web tier only, as ADR-0001 says.
- **Database**: Cloud SQL for PostgreSQL 17, regional high availability (a synchronous standby in a
  second London zone), point-in-time recovery (RPO 15 minutes, RTO 4 hours), private IP only (no
  public address), customer-managed encryption keys (CMEK), the `cloudsql.enable_pgaudit` flag on,
  and logical decoding on (`cloudsql.logical_decoding`) for PowerSync. Forced row-level security
  and the non-owner application role (ADR-0002) are unchanged.
- **Object storage**: Cloud Storage with CMEK, uniform bucket-level access, public access prevention
  enforced and V4 signed URLs for downloads. Buckets: documents (quarantine and clean), exports
  (lifecycle expiry), and the audit archive. The audit archive has a **locked** retention policy of
  365 days, which replaces S3 Object Lock in COMPLIANCE mode; a locked policy cannot be shortened
  or removed, so H-55's default carries over and is still irreversible.
- **Keys**: Cloud KMS in europe-west2 (a regional key ring). Each organisation has its own key for
  crypto-shredding (retention.md): destroying the key version shreds the data. Key destruction is
  scheduled, not instant; the destruction certificate records the scheduled-destruction delay and
  the date the version is destroyed.
- **Secrets**: Secret Manager with regional secrets in europe-west2; the API and worker read them
  through their service accounts, never from environment files.
- **Edge**: an external HTTPS load balancer, Cloud Armor with the OWASP Core Rule Set at pinned
  rule versions (replacing H-140's AWS managed rule versions), Cloud CDN for static files only,
  Certificate Manager for TLS (1.2 or later, through an SSL policy), and Cloud DNS.
- **Images and CI**: Artifact Registry in europe-west2. GitHub Actions authenticate through Workload
  Identity Federation; no service account JSON keys exist.
- **Logging and security**: Cloud Logging buckets in europe-west2. Security logs are kept at least 6
  months (default 400 days) in a locked bucket. Cloud Monitoring for metrics and alerting. Data
  Access audit logs are on for the services that hold personal data. Security Command Center
  Standard.
- **Terraform state**: a versioned Cloud Storage bucket in europe-west2, with CMEK.
- **Email**: Google Cloud has no transactional email service. The email port stays, with an SMTP
  adapter. Choosing the provider (UK or EU processing, with a data processing agreement) is a new
  human action (H-08). Until it is chosen, production email stays off and development uses a local
  mail catcher. Nothing that matters for safety depends on email (ADR-0060).
- **Development, staging and pilots**: Supabase London (ADR-0008), unchanged.

### AWS service and its Google Cloud replacement

| AWS (ADR-0001, ADR-0008, ADR-0031) | Google Cloud (this ADR) |
| --- | --- |
| Region eu-west-2 (London), Terraform region check | europe-west2 (London), organisation policy `gcp.resourceLocations` = `in:europe-west2-locations` |
| Separate dev, staging and prod accounts (AWS Organizations) | An organisation with a Harbour folder and one project per environment |
| ECS Fargate (API, worker, PowerSync) | Cloud Run (minimum 1 instance); GKE Autopilot only if streaming limits are reached |
| ClamAV task on ECS | ClamAV sidecar container on the API's Cloud Run service |
| RDS for PostgreSQL 17, Multi-AZ, PITR | Cloud SQL for PostgreSQL 17, regional HA, PITR, private IP, CMEK |
| RDS parameter group (pgAudit, logical replication) | Cloud SQL flags `cloudsql.enable_pgaudit`, `cloudsql.logical_decoding` |
| S3 with SSE-KMS, presigned URLs | Cloud Storage with CMEK, uniform access, public access prevention, V4 signed URLs |
| S3 Object Lock (COMPLIANCE) for the audit archive | Locked bucket retention policy, 365 days |
| KMS | Cloud KMS (regional key ring in europe-west2) |
| Secrets Manager | Secret Manager (regional secrets) |
| CloudFront | External HTTPS load balancer with Cloud CDN for static files |
| AWS WAF with managed rules | Cloud Armor with the OWASP CRS at pinned versions |
| ACM, Route 53 | Certificate Manager, Cloud DNS |
| ECR | Artifact Registry |
| IAM roles for GitHub Actions (OIDC) | Workload Identity Federation, no JSON keys |
| CloudWatch Logs and metrics | Cloud Logging (buckets in europe-west2, locked for security logs) and Cloud Monitoring |
| CloudTrail | Cloud Audit Logs (Admin Activity always on; Data Access enabled) |
| GuardDuty, Security Hub | Security Command Center Standard |
| Terraform state in S3 with DynamoDB lock | Versioned Cloud Storage bucket (native state locking) |
| Amazon SES (London) | SMTP adapter to a provider still to be chosen (H-08); production email off until then |

### Consequences

- Good, because one region with an enforced location policy keeps production personal data in the
  UK by construction, as AWS's region check did.
- Good, because Cloud Run removes the cluster and task definitions the team would have run on ECS,
  and Workload Identity Federation removes long-lived CI credentials.
- Good, because a locked retention policy gives the same irreversible, tamper-evident audit archive
  as S3 Object Lock.
- Bad, because the API's storage and email adapters are written for S3 and SES
  (`apps/api/src/integrations/storage.ts`, `adapters.ts`) and production configuration requires S3
  (`apps/api/src/config.ts`). A Cloud Storage adapter (signed URLs, CMEK buckets) and an SMTP
  adapter must be built and the production configuration changed before go-live. This is an
  engineering follow-up in STATUS; the ports do not change.
- Bad, because Google Cloud, like AWS, has one UK region, so a full loss of London stops
  server-side services until Google restores it; offline mobile remains the continuity path, as
  ADR-0001 records. Cross-region backups are still not taken, because they would leave the UK.
- Bad, because Cloud Run limits request and streaming durations; PowerSync's long-lived connections
  must be tested at the 60-bed load (section 6 budgets) before production, with GKE Autopilot as
  the fallback.
- Bad, because there is no transactional email until a provider is chosen, so email-only features
  (portal invitations by email, letters by email) stay off in production meanwhile.
- Bad, because several things the AWS plan had must be rebuilt or chosen again before production:
  the operator's log alarms behind H-171 (`worker.job.failed`, `escalation.unrouted.daily`; HZ-008,
  HZ-013) become Cloud Monitoring alert policies in the Terraform rewrite; the restore runbook's
  maintenance rule and scale-to-zero controls; and the certificate pin set (ADR-0028), because
  Certificate Manager issues from Google's CAs, not Amazon's.
- Neutral, because the Cloud SQL edition decides how far back point-in-time recovery reaches
  (Enterprise keeps 7 days of logs, Enterprise Plus up to 35, as the AWS plan had); the edition is
  chosen with H-04 and the restore runbook states the window.
- Neutral, because evidence pack one-time codes go by email (ADR-0050), so public inspector links
  wait for the email provider (H-08) or a fallback.
- Neutral, because the AI gateway's model provider (ADR-0014) is not hosting and is not changed
  here; whether it moves to Google Cloud is a separate decision.
- Neutral, because Cloud KMS destroys key versions after a scheduled delay rather than at once, so
  crypto-shredding certificates state the delay and the date of destruction.
- Neutral, because the sub-processor register, DPIA, records of processing and security documents
  name Google Cloud EMEA Limited under the Cloud Data Processing Addendum instead of AWS
  (sub-processors.md); signing it and setting the organisation policy are human actions (H-1000).

### Confirmation

- The organisation policy `gcp.resourceLocations` is set on the Harbour folder before any
  production resource is created (H-1000); Terraform plans show only europe-west2 resources.
- CI has no service account key: a gitleaks rule and the WIF configuration are reviewed by the
  security reviewer.
- The restore runbook's point-in-time drill (runbooks/restore.md) is run on Cloud SQL before
  go-live and each quarter.
- The audit archive bucket's retention policy shows `isLocked: true`.

## Pros and cons of the options

### Google Cloud europe-west2, managed services

- Good, because it meets every rule with managed services and the owner chose it.
- Bad, because of the adapter work and the email gap above.

### Google Cloud europe-west2 on GKE Autopilot for every service

- Good, because there are no request-duration limits.
- Bad, because the team runs Kubernetes manifests, upgrades and policies for no gain on the API and
  worker.

### Stay on AWS eu-west-2

- Good, because the code and Terraform plan already target it.
- Bad, because the owner decided otherwise.

## The owner's decision on his open decisions (31/10/2026)

The owner decided that every open decision he owns takes the default already in force. In
[human-actions.md](../plans/human-actions.md), every row owned by Brian and every row in "Product
decisions still open" that has a default in force is marked "decided 31/10/2026: default accepted
(owner)". Rows with no default to accept stay open. These are choosing a vendor (for example the
SMS gateway H-09, the IDSP H-521 and the DBS route H-522), accounts, credentials and contracts, and
pricing without a default. Rows owned by the CSO, DPO, advisers or tenants are unchanged. A default
accepted here can still be changed later by a new ADR.

## More information

- Human actions rewritten for Google Cloud: H-04 (organisation, folder, projects, state bucket,
  WIF), H-06 (Artifact Registry), H-07 (Secret Manager), H-08 (email provider), H-16 (ClamAV
  sidecar), H-55 (locked retention policy), H-140 (Cloud Armor rule versions), H-663 (Security
  Command Center and audit logs); H-372 is unchanged; H-1000 is new (Cloud Data Processing Addendum
  and the organisation policy).
- Revisit if Google Cloud opens a second UK region (cross-region recovery inside the UK), or if
  PowerSync cannot run on Cloud Run at the target load.
