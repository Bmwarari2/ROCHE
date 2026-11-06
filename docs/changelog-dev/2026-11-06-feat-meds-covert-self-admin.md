# Covert administration, self-administration and homely remedies (Phase 2 slice 38)

Branch `feat/meds-covert-self-admin`, cut from `feat/meds-administration-schema` (slice 22).
Migration 0142. MEDS-004, MEDS-006, MEDS-007 (partial: web screens are slices 52, 53 and 55).
Hazards HZ-026 (extended) and HZ-120 (added). Human actions H-1350 to H-1359, each with a
recommended answer applied until the testing-phase review.

- Spec: [medicines.md](../specs/medicines.md) section 15; five rate-table rows in
  [rates.md](../specs/rates.md), all to verify; the permission matrix gains
  `medicines.covert.manage`.
- Domain: `checkCovertRecord`, `covertStatus`, `covertDoseFlags`; `checkSelfAdminAssessment`,
  `selfAdminStatus`, `selfAdminDoseFlags`; `checkHomelyProtocol`, `checkHomelyDose`,
  `homelyProtocolStatus`; table-driven tests.
- Database: `covert_medication_record`, `self_administration_assessment`,
  `homely_remedy_protocol`, `homely_remedy_administration` with forced RLS, scope, guards,
  history or append-only, no delete; `medication_administration.covert` and four flags; sample
  removal; the built-in role backfill, audited.
- API: covert records (list, record, review, end), self-administration (read, assess), homely
  remedy protocols (list, add, change, withdraw) and doses (list, give, entered in error); covert
  and self-administered doses are flagged and escalated, never refused. OpenAPI and client
  regenerated; export catalogue, retention, records of processing, data standards, the
  medical-device boundary note, feature register and STATUS updated.
