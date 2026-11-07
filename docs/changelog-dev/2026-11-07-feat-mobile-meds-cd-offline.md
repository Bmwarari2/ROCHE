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

H-1439 (CSO) and H-1440 (security and DPO), with the two pilot risks split out as H-1521 (offline PIN guessing on a copied database) and H-1522 (a watched witness PIN), both fixed by hardware-backed keys with H-1432, and the follow-ups H-1523 to H-1525.

## Batch 5 merge and review fixes

- Main (batch 4 and the rename) merged in: 0153 stays 0153, chained on 0152; its restrictive
  policies now hold the context definers (ADR-0133 check).
- The phone checks the recorder holds `medicines.cd.administer` before a controlled drug is recorded,
  and says so as the dose opens; a controlled drug's conflict is decided on the web with step-up.
- "Needs attention" names the medicine, the outcome and the dose time for a refused medicine record.
- Export catalogue describes the witness signature column. H-1528 (CSO) logged; H-1514 and H-1515
  extended to the renamed slice 69 and 70 text. Maestro `hazard-HZ-116-cd-phone-guards.yaml`
  written, not run.
