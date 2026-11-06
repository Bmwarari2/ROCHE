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
  key versions and their destroy times, and the date backups expire (the longer of
  `DATABASE_PITR_DAYS` and `DATABASE_BACKUP_RETENTION_DAYS`).
- **Migration 0117**: new columns on `destruction_certificate`, with a two-person check, a
  signed-fields check and an insert policy. New table `tenant_shred_request`, with forced RLS
  (tenant-wide holders of the permission only), at most one open request, insert and decide
  policies, a guard trigger and no DELETE.
- **Configuration**: `TENANT_KEY_PROVIDER`, `TENANT_KMS_KEY_RING`, `CERTIFICATE_SIGNING_KEY`,
  `LOCAL_KEYS_DIR`, `DOCUMENTS_LEGACY_PLAINTEXT`, `DATABASE_PITR_DAYS` and
  `DATABASE_BACKUP_RETENTION_DAYS`. Production requires Cloud KMS and both backup settings.
- **Documents**: retention-and-deletion.md section 4 now follows ADR-0109 (no field-level or
  per-person keys). Human actions H-1110 to H-1118 cover the key rings, the signing key, the IAM
  grants, the Cloud Run settings, the backup window, legacy objects and the DPA wording.
- **Terraform**: unchanged. The rings and keys are documented as human actions, because the API
  creates the per-organisation keys itself.

## Security review fixes

The security reviewer found 1 high, 5 medium and 8 low findings; all are fixed or recorded.

- **H1.** Approval commits first (status `shredding`) and only then destroys keys. The certificate
  follows in a second transaction, and the worker completes the shred from the outbox if the API
  cannot. While a request is shredding, it cannot be cancelled and no hold can be placed.
- **M1.** The data-key cache now lasts 30 seconds. It never caches an unwrap that began before a
  shred, hands out copies, and zeroes keys on eviction. The documented window is now honest.
- **M2.** The service account gets a custom KMS role, without restore or setIamPolicy (H-1112).
- **M3.** Requests expire after 7 days, enforced in the database too. At approval, the requester
  must still be eligible, and any holder may withdraw a lapsed request.
- **M4.** A request names a full export downloaded within 30 days, rather than ticking a box.
- **M5.** The signer is inside the signed body, and each signature is checked before it is stored.
  `verify` trusts only Harbour's own certificate key. Responses carry every signed field, and a new
  verification route returns the signed body.
- **Lows:**
  - foreign keys from the request to the certificate and the export, and a certificate insert
    policy;
  - the restrictive policies also apply to `harbour_owner`;
  - the contract step to make signatures mandatory is recorded (H-1117);
  - Cloud KMS settings with missing values now fail instead of falling back;
  - legacy plaintext reads sit behind an explicit flag that production refuses;
  - local keys default to `.data/keys`;
  - backup retention is required in production;
  - keys are zeroed after use;
  - Cloud KMS network errors are redacted;
  - `CreateShredRequest` is strict.

## Data protection and clinical safety

No new personal data: certificates and requests hold opaque ids and the reason text only. Records
of processing and data standards are unchanged. This is not a clinical change.
