# Data security evidence (QUAL-012, Phase 2 slice 32)

Branch `feat/quality-data-security-evidence`, stacked on `feat/platform-breach-register` (slice 20).

## What changed

- Spec: `quality.md` section 18 (tables, rules 32 to 37, permission matrix, retention, tests).
- Database: migration 0094 (lane E; renumbered at merge) adds `dspt_assertion`, `dspt_submission`
  and `security_certificate` (versioned aggregates; creator, organisation and removal fixed) and
  `dspt_evidence` (append-only links to organisation documents). Forced RLS on
  `quality.dsar.manage` held across the whole organisation (a manager for one home sees nothing),
  binding `harbour_owner`; the system reads for renewal tasks.
- API (`quality.dsar.manage` across the organisation, every read and change audited with ids and
  codes only): `GET /v1/data-security` (the DSPT year's status, assertions by status with met but
  unevidenced counted apart, each certificate kind's status, missing never current, and the breach
  register and complaints); DSPT assertions (track, status, link and unlink evidence), submissions
  (record one per year, correct) and certificates (record, list). Statuses come from the rate table on
  every read (rules 29 to 31).
- Worker: renewal tasks once per DSPT deadline (due soon or overdue, unsubmitted) and per certificate
  expiry (due soon or expired), to the owner role.
- Contracts, OpenAPI and the generated client; export catalogue entries.
- No web screens (slice 65).

## Clinical safety and data protection

- No clinical change; hazard log untouched. No new personal data or purpose (staff ids only);
  records of processing and data standards updated; interim `audit_event` retention.

## Tests

- `packages/db/test/data-security-evidence.test.ts`, `apps/api/test/data-security-evidence.test.ts`.

## Human actions logged

- H-810 retention; H-811 the scheme figures and reminder window; H-812 who receives renewal tasks;
  H-813 loading the year's DSPT assertions.
