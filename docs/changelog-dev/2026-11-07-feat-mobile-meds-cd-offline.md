# Controlled drugs, corrections and conflicts on the phone (Phase 2 slice 70)

Branch `feat/mobile-meds-cd-offline`, from slice 69 (`194e220b`). Migration 0153 for now (the
integrator renumbers it in batch 5). ADR-0084 written (its planned number). No SECURITY DEFINER
function is added.

## What changed

- Migration 0153: `member_device_key` (a member's public signing key for one phone database;
  append-only; read by its member or the system's view) and `device_factor` columns on
  `controlled_drug_witness_assertion`.
- API: `POST /v1/me/device-keys` (fresh step-up, a phone bound to the member and not revoked). A
  dose may carry `controlledDrug.deviceSignatures`: verified with node:crypto, then written as the
  register's own witness assertion. Domain: `cdDoseStatementText`, `deviceSignatureIssues`,
  `pairIssues`.
- Phone: medicines PINs on this phone (a witness signs in for this alone); keys with @noble/curves,
  sealed with scrypt and AES-256-GCM; the controlled drug section of the record panel (witness,
  both PINs); referenced corrections; the conflict review for the nurse in charge (online).
- Maestro: `hazard-HZ-004-offline-conflict.yaml` and `medicines-gate-journey.yaml`, written, not run.

## Decisions for people

H-1439 (CSO) and H-1440 (security and DPO).
