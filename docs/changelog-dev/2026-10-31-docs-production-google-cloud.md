# Production on Google Cloud, and the owner's defaults accepted

Branch `docs/production-google-cloud`. Two owner decisions of 31/10/2026.

## What changed

- **ADR-0098**: production runs on Google Cloud europe-west2 (London), enforced by the organisation
  policy `gcp.resourceLocations`. It maps every AWS service to its Google Cloud replacement:
  - Cloud Run for the API, the worker, PowerSync and web, with the ClamAV sidecar;
  - Cloud SQL for PostgreSQL 17 with regional HA, PITR, private IP, CMEK, pgaudit and logical
    decoding;
  - Cloud Storage with CMEK and V4 signed URLs, and a locked 365-day retention policy for the audit
    archive;
  - Cloud KMS keys per organisation for crypto-shredding, and Secret Manager;
  - a load balancer with Cloud Armor (OWASP CRS pinned) and Cloud CDN;
  - Artifact Registry and Workload Identity Federation;
  - Cloud Logging with locked security logs, and Security Command Center Standard;
  - Terraform state in GCS;
  - email through an SMTP adapter to a provider still to be chosen, with production email off until
    then.

  It partly supersedes ADR-0001, ADR-0008, ADR-0031, ADR-0060 and the other ADRs that named AWS
  services; Supabase London for dev, staging and pilots is unchanged. The master prompt is left as
  written; the ADR records the deviation.
- **Documents**: the constraints digest, sub-processor register (Google Cloud EMEA Limited under the
  Cloud Data Processing Addendum), DPIA, records of processing, security checklist, ISO 27001
  mapping, Cyber Essentials, retention, runbooks, specs, plans, hazard log, infra/README.md (the
  plan as prose; the Terraform is rewritten separately) and sources.
- **Human actions**:
  - The AWS rows are rewritten for Google Cloud:
    - H-04: organisation, folder, projects, state bucket and WIF;
    - H-06: Artifact Registry;
    - H-07: Secret Manager;
    - H-08: choosing the email provider;
    - H-16: the ClamAV sidecar;
    - H-55: the locked retention policy;
    - H-140: the Cloud Armor rule versions;
    - H-663: SCC and audit logs;
    - H-05, H-106, H-352, H-356, H-510, H-661 and H-662 wording.
  - H-372 is unchanged.
  - New: H-1000, sign the Cloud Data Processing Addendum and set the organisation policy.
- **Owner decision**: every open decision owned by Brian with a default in force, and every product
  decision with a default, is "decided 31/10/2026: default accepted (owner)" (29 rows; H-470 stays open, as it belongs to the CSO and DPO). Rows with
  no default (vendors, accounts, credentials, pricing, verification against guidance, and rows
  shared with the CSO, DPO or advisers) stay open. The product decisions table gains a Status
  column.

## Not done here (engineering follow-ups, in STATUS)

- The Terraform in `infra/` still targets AWS.
- The API's storage (S3) and email (SES) adapters, and the production configuration that requires
  S3, need Google Cloud Storage and SMTP adapters.
- A PowerSync load test on Cloud Run.

## Human actions logged

- H-1000 (new); H-04, H-06, H-07, H-08, H-16, H-55, H-140 and H-663 rewritten.

## Tests

- Markdown link check, Biome; domain tests for the sub-processor seed.
