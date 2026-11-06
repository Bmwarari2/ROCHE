# Covert administration, self-administration and homely remedies (Phase 2 slice 38)

Branch `feat/meds-covert-self-admin`, cut from `feat/meds-administration-schema` (slice 22).
Migration 0140. MEDS-004, MEDS-006, MEDS-007 (partial: web screens are slices 52, 53 and 55).
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

## Review fixes (06/11/2026)

- Clinical: a covert record stops covering doses once its capacity or best-interests basis changes
  (`basis_changed`); covert only on a given dose; homely doses need the allergy check, can be
  checked without recording, are recorded when already given (flags and an urgent task), count
  doses of the same product under other protocols, and check the gap and the 24 hours both ways.
  The self-administration decision kind and the round display are deferred to slices 52 and 53
  (H-1354), recorded as open in HZ-120.
- Security: entered in error is limited to the giver or `medicines.record.manage` at the person's
  home and is idempotent; the database checks the actor and the permission for doses and
  assessments (`app.may_record_for_person`); resends compare the giver and reason; ending a covert
  record follows the person's lifecycle; the dose check is audited.
- Both reviewers satisfied after the second round.
