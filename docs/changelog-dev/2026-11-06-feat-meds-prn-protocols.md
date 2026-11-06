# PRN protocols, outcomes and the psychotropic report (Phase 2 slice 28)

Branch `feat/meds-prn-protocols`, cut from `feat/meds-administration-schema` (slice 22).
Migration 0143. MEDS-003 (partial: web screens are slice 53). Hazard HZ-117 (reserved for slice
28). Human actions H-1380 to H-1389, each with a recommended answer applied until the
testing-phase review.

- Spec: [medicines.md](../specs/medicines.md) section 16; two rate-table rows in
  [rates.md](../specs/rates.md), both to verify; the permission matrix gains
  `medicines.list.manage`.
- Domain: `checkPrnProtocol`, `prnProtocolStatus`, `checkPrnOutcome`, `prnFrequency`,
  `checkMedicineListItem`; table-driven tests.
- Database: `medicine_list_item`, `prn_protocol`, `prn_outcome` with forced RLS, scope, write
  policies, guards, history or append-only, no delete; sample removal; the built-in role backfill,
  audited. The PRN limits stay on the entry (migration 0123); nothing copies them.
- API: medicine lists (read, add, remove), PRN protocols (list, record, change, withdraw), outcomes
  (record, correct, outstanding) and the PRN frequency report. OpenAPI and client regenerated;
  export catalogue, retention, records of processing, data standards, the medical-device boundary
  note, feature register and STATUS updated.

## Review fixes (06/11/2026)

- Clinical: a protocol is in force from when it was recorded until the instant it was withdrawn,
  so a backdated agreement covers no earlier dose; doses under a protocol past its review are
  counted apart; a protocol's status reads the latest entry (stopped, no longer when required);
  a test that a changed prescription is what the protocol shows; outstanding outcomes have no
  time window; calendar-day counts tested on both clock changes and labelled as calendar days.
- Security: no blocker. For the integrator: migrations 0142 (slice 38) and 0143 both redefine
  `app.sample_removal_tables()`; the one that runs last must list the union of both (slice 38's
  three tables and `prn_outcome`, `prn_protocol`, children before parents). Withdrawal records
  its own change reason; the report's corrections query is bounded to the period's doses.
