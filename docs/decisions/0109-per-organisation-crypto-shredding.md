---
status: accepted
date: 2026-10-31
decision-makers: Engineering (lead session), on the owner's move to Google Cloud (ADR-0098)
consulted: security-reviewer agent
informed: Brian (Thapsus Cargo Ltd), the DPO
---

# Per-organisation crypto-shredding with envelope encryption

## Context and problem statement

Master prompt section 5.1 and [retention.md](../specs/retention.md) say records are soft deleted,
then cryptographically shredded with a certificate; [retention-and-deletion.md](../compliance/retention-and-deletion.md)
sections 4 and 5 describe envelope encryption, key destruction and a signed certificate. Today
documents and exports are encrypted only by the bucket's customer-managed key (CMEK, ADR-0098), one
key for every organisation, so no organisation's data can be made unreadable on its own: an
organisation leaving Harbour after its free export ([DPA clause 9](../compliance/dpa-article-28-template.md))
cannot be shredded without shredding everyone. How should documents, exports and database rows be
encrypted and destroyed so that one organisation, or a subset of its records, can be destroyed with
proof?

## Decision drivers

- Destroy one organisation's stored objects irreversibly, including copies the application cannot
  see (noncurrent generations, objects a failed deletion left behind), and prove it.
- Keep the storage port (`DocumentStoragePort`) and both adapters (Cloud Storage and local disk).
- Cloud KMS quotas and cost: cryptographic operations per minute per project, keys per ring, and
  the monthly price of each active key version.
- Two people, with step-up, approve any whole-organisation shred; every step is audited.
- No personal data in keys, key names, certificates or logs.

## Considered options

1. One Cloud KMS key for every organisation, one key version per organisation.
2. One Cloud KMS key per organisation (a key encryption key, KEK), wrapping a fresh data encryption
   key (DEK) per object, stored in the object's header.
3. One Cloud KMS key per organisation, wrapping one long-lived DEK per organisation stored in the
   database.
4. Field-level envelope encryption of special-category free text in the database as well.

## Decision outcome

Chosen option: **2, one KEK per organisation and a DEK per object**, because it is the only option
that both shreds one organisation by destroying keys and needs no key table to keep consistent.

- Option 1 does not work: Cloud KMS encrypts with a symmetric key's primary version only, so
  versions cannot be assigned to organisations, and destroying one would also destroy the data of
  whichever organisations it was primary for.
- Option 3 keeps a wrapped DEK in the database, whose backups (point-in-time recovery) would then
  hold it after the shred; and a DEK used for every object is a larger blast radius.
- Option 4 is not taken now (see "Database rows" below).

### How it works

- **Keys.** Each organisation has a Cloud KMS key `tenant-<organisation id>` (purpose
  ENCRYPT_DECRYPT, software protection, rotated every 90 days, `destroy_scheduled_duration` 30
  days) in the key ring `harbour-<env>-tenants` in europe-west2, created on first use. Key names
  carry the organisation's opaque id only.
- **Envelope.** Every object (document, export archive, DSAR bundle) gets a fresh 256-bit DEK.
  The object is encrypted with AES-256-GCM in 64 KiB segments (streamed, so an export is never
  held in memory), each segment with its own nonce (a random 7-byte prefix, a 4-byte counter and a
  final-segment flag, so truncation and reordering fail). The header holds a magic and format
  version, the nonce prefix and the DEK wrapped by the organisation's KEK; it is authenticated
  with every segment, together with the storage key, so an object moved to another key does not
  decrypt. The KEK wrap uses the organisation id as additional authenticated data. The bucket's
  CMEK stays as a second layer.
- **Reads.** An unwrapped DEK is cached in memory for at most 30 seconds (by the hash of its
  wrapped form), which keeps Cloud KMS calls well inside the per-project quota. The cache is per
  process: the approving process forgets an organisation's keys on shred (and never caches an
  unwrap that began before), while another API instance or the worker may go on reading for at
  most those 30 seconds.
- **Whole-organisation shred.** Every version of the organisation's KEK is scheduled for
  destruction. From that moment the versions are disabled, so every object of that organisation
  (live, noncurrent or left behind) stops decrypting in Cloud KMS at once (cached keys aside, as
  above); after the 30-day delay the key
  material is destroyed and cannot be restored by anyone, Google included. The delay is the only
  window in which a mistaken shred can be undone, by restoring the versions in Cloud KMS (a human
  action, recorded). The certificate records the key version names, the time destruction was
  scheduled and the time it completes.
- **A subset of records** (retention reached, or a legal hold released on some records) is not
  shredded by key: each object is destroyed individually (every generation deleted; the bucket
  keeps no soft-deleted copies), as `POST /v1/retention/destroy` does today, with a certificate.
  Per-person keys would add a key per person per organisation without reaching anything the
  object deletion does not already reach.
- **Two people.** A member with `platform.retention.manage` (step-up, tenant-wide) requests the
  shred, naming the organisation's full export, which must have been downloaded within 30 days
  (the shred destroys the export too), and giving a reason; a different member with the same
  permission (step-up) approves it within 7 days, while the requester is still an active member
  holding the permission, and only then are the keys destroyed. Active legal holds block both
  steps. A lapsed request can be withdrawn by any holder. The API and the database (a check, the
  decide policy and a guard trigger) refuse the same person twice and a late approval.
- **Approval before keys** (security review H1). Destroying key versions cannot be undone, so it
  never runs inside a transaction that can roll back. Approval commits first, under the
  organisation's retention lock: the request moves to `shredding`, the approval is audited and an
  outbox event is published; from then on it cannot be cancelled and no legal hold can be placed.
  Completion then destroys the keys, forgets cached keys and, in a second transaction, issues the
  certificate and moves the request to `approved`. The API completes it at once; if the keys or
  the signing key cannot be reached, the worker retries from the outbox event until it succeeds
  (the key provider's shred is idempotent), logging each failure as `worker.job.failed`.
- **Certificate.** A destruction certificate (append-only) records what was destroyed, the rule,
  the reason, the method, the two people (opaque ids), the KEK version names and their destroy
  times, and the date by which database backups have expired. Its canonical JSON is hashed
  (SHA-256) and signed by Harbour's certificate signing key, an asymmetric Cloud KMS key
  (EC_SIGN_P256_SHA256) whose private half never leaves Cloud KMS. Every certificate is signed,
  the subset destructions' too. The signing key and algorithm are inside the signed body, each
  signature is checked before it is stored, verification trusts only versions of Harbour's own
  certificate key (never a key a row names elsewhere), and
  `GET /v1/destruction-certificates/{id}/verification` returns the exact body that was signed, so
  anyone with the published public key (H-1111) can check it. A certificate states the backup
  expiry as the longer of the point-in-time recovery window and the backup retention, both
  required settings in production (H-1114).
- **Local and tests.** The local disk adapter gets the same envelope. A local key provider keeps
  per-organisation keys in files (or in memory in tests) and signs with a local Ed25519 key; it
  is refused in production.

### Database rows

No field-level encryption for now. Rows are soft deleted, then hard deleted with a certificate,
as retention.md and retention-and-deletion.md section 2 set; deleted rows leave the database's
backups when point-in-time recovery's window passes (7 days on Enterprise, 35 on Enterprise Plus),
and the certificate records that date. Field-level encryption of special-category free text (care
notes, incident narratives) would need its search vectors redesigned in the same change, or the
words outlive the key (ADR-0070, H-380), and would make reporting over that text impossible
in the database. It stays a recorded option: if a regulator or a DPIA requires backups to become
unreadable before the window passes, it is the next step, starting with `care_note.body`.

### Consequences

- Good, because one organisation's objects become unreadable everywhere the moment its shred is
  approved, and irrecoverable after the delay, with a signed certificate.
- Good, because a key per organisation keeps IAM, rotation and destruction independent, with no
  key table to drift from the objects.
- Bad, because each read of an uncached object costs a Cloud KMS decrypt (priced per 10,000
  operations) and each organisation's key costs about the price of one or two active key versions a
  month; both are small next to Cloud SQL.
- Bad, because the API's and the worker's service account needs a custom role on the tenants key
  ring only (security review M2): `cloudkms.cryptoKeys.create`, `get` and `update` (to stop
  rotation), `cloudkms.cryptoKeyVersions.list` and `destroy`, and
  `cloudkms.cryptoKeyVersions.useToEncrypt` and `useToDecrypt`; never `restore` or `setIamPolicy`,
  so a compromised API cannot undo a shred. Restoring versions in the 30-day window is a human
  break-glass role. Signing needs `roles/cloudkms.signerVerifier` on the certificate key only.
- Bad, because certificates issued before migration 0117 stay unsigned; a later contract migration
  makes the signature columns NOT NULL once every writer signs (H-1117).
- Neutral: objects written before this change (local development only; nothing is in production)
  are read as plain bytes only when `DOCUMENTS_LEGACY_PLAINTEXT=on`, which is off by default and
  refused in production, so no deployed environment serves them.

### Confirmation

Tests: envelope round trips (single and streamed, empty, multi-segment), tampering, truncation and
moved objects refused; reads fail after a shred; certificate contents and signature verified;
two-person and step-up enforced in the API and the database; expiry and requester eligibility; a
signing failure after the keys are destroyed leaves the approval committed and the worker
completes it. The key ring, the certificate signing
key and the IAM grants land with the infrastructure branch (`feat/infra-google-cloud`), recorded as
human actions H-1110 to H-1117 until then.
