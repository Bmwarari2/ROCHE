---
status: "accepted; partly superseded by ADR-0098"
date: 2026-10-11
decision-makers: Claude Code (build), Brian (product owner, informed)
consulted: security-reviewer agent
informed: Brian
---

# Document storage, malware scanning and destruction past retention

> **Partly superseded by [ADR-0098](0098-production-on-google-cloud.md) (production on Google
> Cloud), 31/10/2026**: S3, AWS KMS and ClamAV in AWS. Documents are stored in Cloud Storage with
> customer-managed Cloud KMS keys, uniform bucket-level access and V4 signed URLs, and ClamAV runs
> as a sidecar container on the API's Cloud Run service. The ports, scanning rules, key layout and
> destruction rules are unchanged; Cloud KMS destroys a key version after a scheduled delay, which
> the destruction certificate states. The text below is kept as decided.

## Context and problem statement

Phase 1 needs a document store (section 9.1) for person photos (HZ-001), wound and skin photos,
letters, legal authority evidence and organisation documents, with e-signature, versioning and a
retention class per document; and the retention engine (section 5.1) needs legal holds and
provable destruction. Uploads are an attack surface (ASVS 5.0 V5): files must be checked by
content, scanned for malware and served so they can never run as script.

## Decision drivers

- Personal data stays in the UK (AWS eu-west-2) and encrypted at rest with KMS.
- No file is served unscanned in production; scanner outages fail safe.
- Storage keys never contain personal data.
- Destruction must remove every stored version and leave proof.

## Considered options

- Uploads through the API to a storage port (local disk in development, S3 in AWS), scanned in the
  API with ClamAV, served through the API (chosen).
- Presigned S3 uploads straight from the browser or device, scanned asynchronously by an S3 event.
- A third-party document service.

## Decision outcome

Chosen option: "uploads through the API", because the API can check content, scan and audit before
anything is stored or served, with no separate pipeline to operate in Phase 1, and the largest
file (25 MB) is small enough to pass through the API.

1. **Checks.** Content is sniffed (JPEG, PNG, WebP or PDF, as the category allows; never SVG or
   HTML); the declared type must agree; category size limits (photos 10 MB, attachments 15 MB,
   documents 25 MB) under an API-wide 26 MB cap; file names are reduced to safe display labels.
2. **Scanning.** `MalwareScanPort` with a ClamAV (INSTREAM) adapter in AWS and an EICAR-aware mock
   in tests. An infected file is refused and nothing is stored; if the scanner cannot answer, the
   file is stored but quarantined and never served. Production refuses to start with the mock.
3. **Storage.** `DocumentStoragePort` with local disk (development, tests) and S3 (versioned,
   SSE-KMS, bucket from Terraform). Keys are `tenants/{tenant}/documents/{document}`.
4. **Serving.** Through the API only, audited, with `X-Content-Type-Options: nosniff`, a sandboxing
   Content Security Policy, `Cache-Control: no-store`, and `attachment` disposition except for
   photos.
5. **Versions and signatures.** A new version is a new row pointing at the previous one; typed-name
   signatures are append-only and bound to the SHA-256 of the version the signer read.
6. **Holds and destruction.** Legal holds on a person or a record stop destruction. Destruction is
   a tenant-wide decision (owner or quality lead, step-up): every stored version is deleted, the row
   becomes a tombstone without its title, and an append-only destruction certificate records the
   ids, class, rule, reason and method.

### Consequences

- Good, because nothing reaches storage or a viewer without content checks and a scan verdict.
- Good, because destruction is provable and cannot remove held records.
- Bad, because uploads cost API bandwidth; revisit with presigned uploads and event scanning if
  volume grows (offline mobile photos may need this in slice 10).
- Neutral, because ClamAV needs a sidecar container and image (human action H-16); until then,
  production uploads stay quarantined, which is safe but blocks the feature.

### Confirmation

`packages/domain/src/platform/documents.test.ts` (sniffing, limits, names, signatures, holds);
`packages/db/test/documents-and-retention.test.ts` (scope, append-only, tenant-wide holds);
`apps/api/test/documents.test.ts` (photo headers, malware refusal, limits, scope, versions,
signatures, holds and certificates); `apps/api/test/config.test.ts` (production refuses local
storage and the mock scanner).

## More information

Related: ADR-0002 (tenancy and RLS), ADR-0030 (browser security), [retention.md](../specs/retention.md),
[security checklist](../compliance/security-checklist.md) V5.
