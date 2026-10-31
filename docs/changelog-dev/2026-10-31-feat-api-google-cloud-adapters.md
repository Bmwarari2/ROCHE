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

## Not done here (outside the brief, for the lead)

- No V4 signed URLs, and no separate quarantine bucket. The API has never issued signed URLs:
  every download streams through it, so each one is authorised and audited (§5.5). Quarantine is
  the document's status in the database.
- `apps/api/Dockerfile` still adds the AWS RDS CA bundle. The `infra/` Terraform and
  `.github/workflows/terraform.yml` are still AWS.
- `.env.example` could not be read in this session, so it was not changed.

## Human actions logged

- None.

## Tests

- New contract tests (`storage.test.ts`, `smtp.test.ts`), using an in-memory bucket double and
  nodemailer's stream transport. No network and no real cloud service.
  - One `DocumentStoragePort` contract runs against both local disk and Cloud Storage.
  - Config and adapter tests are updated.
- `pnpm lint`, `pnpm typecheck` and the licence check pass.
- `pnpm audit --prod --audit-level high`, the CI gate, passes as it does on `main`.
