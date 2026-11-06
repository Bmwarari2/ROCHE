# Security control mapping refreshed for Google Cloud (Phase 2 slice 80)

Branch `docs/security-controls-gcp`, cut from `docs/production-google-cloud`
(`integration/google-cloud` did not exist yet).

## What changed

- **ISO/IEC 27001:2022 Annex A** ([iso27001-controls.md](../compliance/iso27001-controls.md)): the
  cloud controls now cite the evidence for each one: the module, the `terraform test` assertion and
  the file path, drawn from the Google Cloud Terraform (`feat/infra-google-cloud`), the API
  adapters (`feat/api-google-cloud-adapters`) and crypto-shredding (`feat/platform-crypto-shred`).
  - Each piece of evidence is tagged by its branch until `integration/google-cloud` merges.
  - **Met** means code plus a test. Anything that needs a human action other than the first apply
    is **Partly met**, and names that action.
  - The new counts are 32 Met, 34 Partly met, 16 Gap and 11 Inherited (previously 26 Met, 40 Partly
    met).
  - Now Met: 5.17, 5.23, 8.9, 8.14, 8.20, 8.22 and 8.31.
  - 8.8 moves from Met to Partly met, because the built images are not scanned (H-1170).
- **Cyber Essentials** ([cyber-essentials.md](../compliance/cyber-essentials.md)): the five controls
  for the cloud scope (firewalls, secure configuration, security update management, user access
  control and malware protection) are re-mapped to the same evidence.
  - The new counts are 9 Met, 9 Partly met and 3 Gap. All three gaps are Thapsus devices or
    practice.
- **Security checklist** ([security-checklist.md](../compliance/security-checklist.md)):
  - rows V5, V11, V12, V13 and V16 now cite the Terraform tests and crypto-shredding;
  - the NCSC logging row now names Cloud Logging instead of Grafana Cloud;
  - the image scan is marked as not yet in place.
- **Corrections**: claims the Terraform does not support are removed. Operators using IAM database
  authentication is not built, and becomes H-1175. A read-only root filesystem is not a Cloud Run
  setting.
- **Human actions** H-1170 to H-1179:
  - image scanning;
  - MFA evidence for Thapsus cloud accounts;
  - external vulnerability and TLS scans;
  - Google Cloud's own ISO 27001 and SOC 2 reports on file;
  - refreshing the mapping after the merge;
  - the emergency database access route;
  - the capacity plan and alert channels;
  - Supabase in the Cyber Essentials scope;
  - triaging the open Dependabot alerts;
  - folder-level organisation policies.

No code changes. The one small gap found, container image scanning, lives on the infra branch, so
it is recorded as H-1170 rather than changed here.
