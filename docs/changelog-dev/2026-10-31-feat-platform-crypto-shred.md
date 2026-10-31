# Per-organisation envelope encryption and crypto-shredding (PLAT-012)

Branch `feat/platform-crypto-shred`, cut from `feat/api-google-cloud-adapters`.
[ADR-0109](../decisions/0109-per-organisation-crypto-shredding.md); spec
[platform.md](../specs/platform.md#crypto-shredding-plat-012-adr-0109).

## What changed

- **Envelope encryption** (`apps/api/src/integrations/envelope.ts`): every stored document, export
  archive and DSAR bundle is encrypted before it reaches storage, with a fresh 256-bit data key
  wrapped by the organisation's own key. AES-256-GCM in 64 KiB segments; the header and the storage
  key are authenticated with each segment, so tampering, truncation, reordering and moving an object
  are refused. The storage port is unchanged: `EncryptingDocumentStorage` wraps the Cloud Storage
  and local disk adapters alike. A streamed read unwraps its key before any byte is sent. Objects
  written before this change are still read outside production.
- **Key providers** (`apps/api/src/integrations/tenant-keys.ts`): `CloudKmsTenantKeys`, with one
  Cloud KMS key per organisation (`tenant-<id>` in `harbour-<env>-tenants`, created on first use,
  90-day rotation, 30-day scheduled destruction), and `LocalTenantKeys` for development and tests.
  Certificates are signed with ECDSA P-256 in Cloud KMS, or Ed25519 locally. The client is
  `google-auth-library` 11.3.2 (Apache-2.0).
- **Shredding** (`apps/api/src/routes/shred.ts`): `GET` and `POST /v1/retention/shred-requests`,
  plus `/{id}/approve` and `/{id}/cancel`. Each needs `platform.retention.manage` with step-up and
  is tenant-wide only. Two different people are required, and an active legal hold blocks both
  steps. Approval schedules every key version for destruction, drops cached data keys and issues a
  signed certificate. From then on, reads and writes of the organisation's objects return
  `410 shredded`. Every step is audited, refusals included.
- **Signed certificates** (`apps/api/src/services/certificates.ts`): the per-document destruction
  certificates are now signed too. Each stores the SHA-256 of its canonical body, the signature, the
  key versions and their destroy times, and the date backups expire (`DATABASE_PITR_DAYS`).
- **Migration 0117**: new columns on `destruction_certificate`, with a two-person check and a
  signed-fields check. New table `tenant_shred_request`, with forced RLS (tenant-wide holders of
  the permission only), at most one pending request, insert and decide policies, a guard trigger and
  no DELETE.
- **Configuration**: `TENANT_KEY_PROVIDER`, `TENANT_KMS_KEY_RING`, `CERTIFICATE_SIGNING_KEY`,
  `LOCAL_KEYS_DIR` and `DATABASE_PITR_DAYS`. Production requires Cloud KMS.
- **Documents**: retention-and-deletion.md section 4 now follows ADR-0109 (no field-level or
  per-person keys). Human actions H-1110 to H-1116 cover the key rings, the signing key, the IAM
  grants, the Cloud Run settings, the backup window, legacy objects and the DPA wording.
- **Terraform**: unchanged. The rings and keys are documented as human actions, because the API
  creates the per-organisation keys itself.

## Data protection and clinical safety

No new personal data: certificates and requests hold opaque ids and the reason text only. Records
of processing and data standards are unchanged. This is not a clinical change.
