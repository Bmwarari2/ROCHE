---
status: "accepted"
date: 2026-11-07
decision-makers: engineering (Claude Code sessions), for the lead of Phase 2
consulted: clinical safety officer (HZ-001, HZ-113; H-512, H-1432 to H-1435), security review of 07/11/2026
informed: Registered Managers in the pilot
---

# Barcodes and positive identification at the point of care

## Context and problem statement

The Phase 2 plan reserves this ADR for pack barcodes and positive identification (phase-2.md,
decisions table). Mobile slice 69 brings the medicines round to the phone, where the wrong person
(HZ-001) and the wrong pack (HZ-113) are the two errors a scan or a check can catch. The
administration record had a `scan_evidence` hook column and nothing else.

## Decision drivers

- Safety of the person: a dose given needs the person positively identified and the pack checked.
- Dignity: many people in care homes do not wear wristbands; H-512's recommended answer makes photo
  confirmation each person's default.
- No migration where a hook already exists; the phone works offline.

## Considered options

1. Checks on the phone only, nothing stored.
2. Checks on the phone, sent with the record and kept as its barcode evidence.
3. New columns and flags on `medication_administration` for each check.

## Decision outcome

Option 2.
- **Packs**: GS1 DataMatrix (AI 01 GTIN, 17 expiry, 10 batch, 21 serial; raw with FNC1 or bracketed)
  and linear GTIN-8, -12, -13 and -14 with a valid check digit (`parsePackBarcode`). A scan is
  matched through the device subset (ADR-0130): the GTIN in force today, its AMPP, and that AMPP's
  AMP (or, for an entry prescribed generically, its VMP) against the MAR entry (`checkPack`). A
  different product or a pack past its expiry stops the dose; a GTIN the data does not hold is
  checked by hand. A dose given with no match needs an override reason (no barcode, will not scan,
  not in the data, the person's own supply, or other with words).
- **People**: photo confirmation (the point-of-care header's photo, name and date of birth) or the
  person's wristband token. Wristband tokens are not issued yet (H-1433), so the phone offers photo
  confirmation only.
- **Rule**: `pointOfCareIssues` (HZ-001): a dose given needs both checks; an outcome that gives
  nothing needs neither. The phone checks it before recording; the API checks it again whenever a
  record carries `pointOfCare`, and keeps what was sent as `scan_evidence` (GTIN, batch and expiry;
  no serial, which is not needed). The web round sends none yet, so the API does not require it.
- **Device**: the camera reads barcodes on the device only; no frame is stored or sent, so no photo
  is collected (the Android `CAMERA` permission is no longer blocked).
- **eMAR gate**: the phone's round needs a device the on-device root and jailbreak checks
  (`jail-monkey`, MIT) trust; server-verified attestation (Play Integrity, App Attest) is H-1432.

### Consequences

- Good: no migration; the evidence is on the record and in the export; the rule is one domain
  function shared by the phone and the API.
- Bad: records made on the web carry no evidence until the web round sends it; on-device integrity
  checks can be bypassed until attestation lands.

### Confirmation

`packages/domain/src/medicines/barcodes.test.ts` (`hazard HZ-001 refuses an administration without
wristband scan or photo confirmation`, `hazard HZ-113 a pack is matched to the MAR entry's
product`), `apps/api/test/medicine-administrations.test.ts`, `apps/mobile/src/medicines/record.test.ts`,
`apps/mobile/src/security/device-integrity.test.ts`.
