# Phase 2 slice 80, Cyber Essentials and ISO 27001 control mapping

Branch `docs/security-control-mapping`.

## What changed

- `docs/compliance/cyber-essentials.md`: the scope (cloud services Thapsus administers, the Harbour
  service, Thapsus end-user devices) and the five control themes (firewalls, secure configuration,
  security update management, user access control, malware protection), each requirement with how
  it is met, the evidence (Terraform modules, CI workflow steps, ADRs, tests), a status (met, partly
  met, gap) and the owner of each gap; what to close before booking Cyber Essentials Plus.
- `docs/compliance/iso27001-controls.md`: all 93 ISO/IEC 27001:2022 Annex A controls with status,
  evidence and gap owner, and a summary (35 met, 31 partly met, 16 gaps, 11 inherited from AWS);
  the management system clauses 4 to 10 are noted as not yet in place.
- Neither document claims certification: Thapsus holds neither certificate. H-40, H-41, H-536 and
  H-537 stay human actions.
- The compliance index and the security checklist link to both documents.

## Main gaps found

- Thapsus end-user devices are not documented at all (inventory, updates, firewall, anti-malware,
  encryption, MFA on cloud accounts): the largest Cyber Essentials gap.
- No Thapsus information security policy set and no people controls (screening, contracts, NDAs,
  training, leavers, access reviews).
- No CloudTrail, GuardDuty, Security Hub or AWS Config in the Terraform.
- Built but not yet in place: branch protection (H-02), the ClamAV sidecar (H-16), pinned WAF rule
  versions (H-140), the first restore drill (H-45), the deploy role tightened with IAM Access
  Analyzer, the mobile root and jailbreak check (eMAR slice), certificate pinning (ADR-0028
  proposed), operator impersonation approval.

## Human actions logged

- H-660 information security policy set; H-661 people controls; H-662 Thapsus devices in the Cyber
  Essentials scope; H-663 AWS account security services; H-664 ISO 27001 management system clauses
  (lane E's block for this slice, H-660 to H-669).

## Tests

- Documentation only. `node scripts/check-markdown-links.mjs` passes; every evidence path cited was
  checked to exist.
