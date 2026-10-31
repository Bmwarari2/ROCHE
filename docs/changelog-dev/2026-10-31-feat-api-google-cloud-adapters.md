# The API's cloud adapters move to Google Cloud

Branch `feat/api-google-cloud-adapters`. The owner decided on 31/10/2026 that production moves from
AWS to Google Cloud. ADR-0098, on its own branch, records the target: europe-west2 only, Cloud
Storage with CMEK, Cloud KMS, Secret Manager, and SMTP for email.

## What changed

- **Storage** (`apps/api/src/integrations/storage.ts`): `GcsDocumentStorage` (`@google-cloud/storage`,
  Apache-2.0) replaces the S3 adapter, behind the same `DocumentStoragePort`.
  - Every write names the bucket's customer-managed key and validates with CRC32C.
  - The only object metadata is the content type: no file name, title or disposition.
  - Streamed writes (the export) are resumable uploads. A failed upload is never finalised.
  - `destroy` deletes every generation and lists them again. Any failure throws
    `StorageDeleteFailed` with the error code only (keeps #134 M2).
  - `health` is ok only when the bucket is in europe-west2, uses the configured key by default and
    keeps no soft-deleted copies, which would outlive destruction.
  - Local disk stays for development and tests.
  - `@aws-sdk/client-s3` is removed.
- **Email** (`apps/api/src/integrations/adapters.ts`): `SmtpEmail` (nodemailer, MIT-0, on the
  allowlist under ADR-0024) replaces SES, behind the email port. The tenant's provider is `smtp`.
  - Plain text only. TLS 1.2 or later with verified certificates.
  - Results carry the reply code or nodemailer's code, never the reply text, which can quote the
    address.
  - Production email stays off (unconfigured, failing clearly) until a relay is named. Elsewhere
    the adapter sends to Mailpit on 127.0.0.1:1025.
  - `@aws-sdk/client-sesv2` is removed. A stored connection that still names `ses` now resolves to
    "not configured".
- **Config** (`apps/api/src/config.ts`):
  - New settings: `DOCUMENT_STORAGE` (`local` or `gcs`), `GCP_PROJECT_ID`,
    `GCS_DOCUMENTS_BUCKET`, `GCS_EXPORTS_BUCKET` and `GCS_KMS_KEY`. The key must be in
    europe-west2, which is the region allowlist.
  - SMTP settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`, `SMTP_USER` and `SMTP_PASSWORD`.
  - The `S3_*` settings are gone.
  - Production refuses to start in these cases:
    - storage other than `gcs`;
    - any Google Cloud setting missing;
    - one bucket for both documents and exports;
    - SMTP without TLS, to a local host, or with a user but no password.
- **Secret references** (`routes/integrations.ts`): the reference must be a regional Secret Manager
  secret in europe-west2 (`projects/<p>/locations/europe-west2/secrets/<name>[/versions/<n>]`).
  The AWS ARN form is no longer accepted. OpenAPI is regenerated.
- **Other references**:
  - The demo-seed guard test refuses a Cloud SQL host where it used to refuse an RDS host.
  - Comments in Flagsmith, export, DSAR, ports and schema now name europe-west2, CMEK and SMTP.
  - `sub-processors.ts` is untouched: the docs branch owns it.
- **No Cloud KMS adapter**: no code calls AWS KMS. Encryption is bucket-level (formerly SSE-KMS,
  now CMEK), and nothing in the API shreds a key.

- **API image** (`apps/api/Dockerfile`):
  - The image no longer downloads the AWS RDS CA bundle or sets `NODE_EXTRA_CA_CERTS`.
  - ADR-0098 puts Cloud SQL on a private IP, with no Auth Proxy or connector, and TLS from the API.
    Cloud SQL's server CA belongs to the instance, so there is no global bundle to bake in at build
    time.
  - Runtime contract for the Terraform branch (`feat/infra-google-cloud`, not yet pushed when this
    was written):
    - the Cloud Run services for the API, worker and migrate job mount the instance's server CA
      from Secret Manager at `/secrets/cloudsql/server-ca.pem`;
    - they set `NODE_EXTRA_CA_CERTS` to that path, and `DATABASE_SSL_MODE` for the migrator.
    - Without the variable, a verifying connection fails rather than trusting anything else.
  - `infra/README.md` ("CA bundle" row) and `infra/modules/harbour_stack/variables.tf` (default
    `/app/certs/rds-global-bundle.pem`) still name the old path. That builder owns them.

## Decided by the lead

- No V4 signed URLs, and no separate quarantine bucket. Downloads keep streaming through the API,
  so each one is authorised and audited (§5.5). Quarantine stays the document's status in the
  database. ADR-0098 is to be amended to match.
- No Cloud KMS adapter. Per-organisation crypto-shredding was never built, and encryption is
  bucket-level. The lead logs it as a gap against the retention spec.

## Still to do elsewhere

- `.env.example` must replace the `S3_*` settings with `DOCUMENT_STORAGE=local` (or `gcs` with
  `GCP_PROJECT_ID`, `GCS_DOCUMENTS_BUCKET`, `GCS_EXPORTS_BUCKET`, `GCS_KMS_KEY`) and the `SMTP_*`
  settings. The lead will do it; it was left unchanged here.
- The `infra/` Terraform and `.github/workflows/terraform.yml` are still AWS. The Terraform
  branch owns them.

## Human actions logged

- None.

## Tests

- New contract tests (`storage.test.ts`, `smtp.test.ts`), using an in-memory bucket double and
  nodemailer's stream transport. No network and no real cloud service.
  - One `DocumentStoragePort` contract runs against both local disk and Cloud Storage.
  - Config and adapter tests are updated.
- `pnpm lint`, `pnpm typecheck` and the licence check pass.
- `pnpm audit --prod --audit-level high`, the CI gate, passes as it does on `main`.
