# Medicines (`medicines`) - specification

Master prompt sections 10.2 and 10.3, with 17.1 (offline eMAR) and 18 (data model). Phase 2 builds
the eMAR ([phase-2.md](../plans/phase-2.md), lane A; ADR-0012 builds it rather than integrating a
vendor). **Stub**: written with the Phase 2 plan to hold the headings and the rows; slice 2 writes
it in full before any code. Status per feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Section 10.2: the medicines record, administration rounds and the registers a care home keeps, with
the rules in section 10.3 that protect people.

| Row | Feature (register) | Phase | Plan slices |
| --- | --- | --- | --- |
| MEDS-001 | dm+d-coded medicines record and reconciliation (admission, transfer, change, return from hospital) | 2 | 2, 10, 16, 49, 52 |
| MEDS-002 | Offline administration rounds with barcode and person confirmation, time-critical rules and the 10.3 safety rules | 2 | 3, 22, 48, 53, 68 to 70 |
| MEDS-003 | PRN protocols with outcomes and psychotropic PRN report | 2 | 3, 28, 53, 69 |
| MEDS-004 | Covert administration records with best-interests evidence | 2 | 38, 53 |
| MEDS-005 | Electronic controlled-drugs register with two signatures and running balances | 2 | 3, 34, 54, 70 |
| MEDS-006 | Self-administration risk assessment and review | 2 | 38, 52 |
| MEDS-007 | Homely remedies protocols | 2 | 38, 55 |
| MEDS-008 | Stock, 28-day cycle ordering and disposal records, with fridge and room temperature logs | 2 | 42, 55 |
| MEDS-012 | Medication errors and near misses with notification rules | 2 | 7, 45, 55 |
| MEDS-013 | Annual medication review tracker and competence gating with logged override | 2 | 3, 45, 55 |
| MEDS-014 | Printable MAR chart and CD register exports | 2 | 50, 54 |

Not in Phase 2: MEDS-009 GP proxy ordering and MEDS-010 pharmacy interface (Phase 5), MEDS-011 home
care levels of support (Phase 4). The dm+d reference data and its download are INTG-006
([integrations.md](integrations.md)).

## 2. Schema

To be written in slice 2. Section 18 names the entities and the fields that matter most:

- `medication`: dm+d code and description, strength, form, route, dose instructions, schedule type
  (regular, PRN, variable, covert, self-administered, homely remedy), prescriber, indication,
  start, stop and review, CD schedule; reconciliation history kept.
- `medication_schedule`: the times a medicine is due.
- `medication_administration`: schedule, due time, outcome, dose given, reason codes, administered
  by, witnessed by, scan evidence, covert flag, site (patch), stock after; append-only, with no
  UPDATE or DELETE grant; a controlled drug needs a witness.
- `controlled_drug_entry`: ledger page key (person, drug, form, strength), movement type, quantity,
  balance, two signatures; a separate table to mirror the register; append-only.

Retention classes ([retention.md](retention.md)): `mar_chart` for medicines, schedules and
administrations; `controlled_drugs_register` (and `mar_chart` for administrations) for CD entries.

## 3. Permissions

In the catalogue since Phase 0 (`packages/domain/src/platform/permissions.ts`; matrix in
[permissions.md](permissions.md)): `medicines.record.manage`, `medicines.emar.administer`,
`medicines.cd.administer` (step-up), `medicines.cd.witness`, `medicines.stock.manage`,
`medicines.override.approve`. All are care-record permissions (MFA). Slice 2 sets the matrix for
the Phase 2 features and any permission they add.

## 4. Rules that are easy to get wrong

To be written in slice 2 with a table-driven test for each. Section 10.3 requires that the app:

- refuses to record an administration without a selected person, a dose and an outcome;
- requires a witness for controlled-drug entries where the tenant policy says so (default on in
  residential and nursing homes; a lone worker in home care or supported living records "no witness
  available" with the reason, flagged for manager review);
- blocks duplicate administration within the minimum interval and requires an override reason;
- shows the last-given time for every PRN;
- locks a MAR row once synced and allows only referenced corrections;
- keeps device clocks honest by recording server-received time and flagging drift over
  `sync.clock_drift_flag_minutes`;
- reconciles offline rounds on sync with a conflict review screen for the nurse in charge.

Section 10.2 adds late and early warnings with time-critical rules, and annual competence that
blocks administration when expired, with the manager override logged. Rate keys in use:
`medicines.paracetamol.min_interval_hours`, `medicines.bisphosphonate.before_food_minutes`,
`medicines.review_interval_months`, `medicines.ordering_cycle_days`, `medicines.fridge_min_celsius`,
`medicines.fridge_max_celsius`, `medicines.room_max_celsius`, `competence.medicines.refresh_months`.

## 5. API and events

To be written in slice 2 (operations) and slices 10, 16, 22, 28, 34, 38, 42, 45, 48 and 50.

## 6. Offline behaviour

Section 17.1: a full round offline for the people assigned; barcode scans validated against the
cached dm+d subset; CD witness captured locally; on reconnect, conflicts (another device recorded
the same dose) go to a review screen for the nurse in charge. Medicines for assigned people are
reference data that is never evicted while the assignment stands (section 17.2). Root or jailbreak
detection disables the eMAR. Plan slices 68 to 70.

## 7. Clinical safety

Hazards in the [hazard log](../clinical-safety/hazard-log.md) with Phase 2 controls: HZ-001, HZ-002,
HZ-003, HZ-004, HZ-005, HZ-007, HZ-008, HZ-009, HZ-010, HZ-021, HZ-023, HZ-026. New hazards HZ-113 to
HZ-122 are added by the slices the plan names. Medical-device boundary: re-check
[medical-device-boundary.md](../compliance/medical-device-boundary.md) in every pull request; the
allergen-matching grey area (section 6) is decided by ADR-0082 before the administration screen.

## 8. Data protection

Purpose B1 in the [records of processing](../compliance/records-of-processing.md); dm+d fields in
[data-standards.md](data-standards.md) (section 18, data-standard alignment). No new sub-processor.

## 9. Acceptance criteria and tests

To be written in slice 2. The Phase 2 gate needs: a medication round completed offline with barcode
and witness in the Maestro suite; expired competence blocking administration in tests. The hazard
log already names planned tests for HZ-001 to HZ-010.

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0080 to ADR-0085) and the
human actions H-510 to H-517 in [human-actions.md](../plans/human-actions.md).
