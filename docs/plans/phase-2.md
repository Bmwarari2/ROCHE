# Phase 2: Medicines and workforce

## Summary

Phase 2 adds the two things a care home cannot run a week without after the care record: medicines
and staff. It builds the eMAR end to end (the dm+d-coded medicines record and reconciliation,
administration rounds that work offline on the phone with barcode and person confirmation and the
section 10.3 safety rules, PRN protocols, covert administration, the controlled drugs register with
two signatures, self-administration, homely remedies, stock, ordering, disposal and temperature
logs, errors, reviews and the printable MAR); the workforce file (applicant tracking, the Reg 19
Schedule 3 pre-employment file, sponsor-licence duties, induction and the Care Certificate, the
training matrix, observed competence that blocks actions when it expires, supervision, casework,
staff data protection, leavers); rostering, time and pay (the dependency tool and safe staffing
planner, the rota builder, Working Time checks, time and attendance, the pay rules engine with NMW,
holiday and SSP rules, payroll and pension exports, agency workers, absence, wellbeing and
lone-worker safety); the rest of section 11.1 (safeguarding log, complaints, whistleblowing,
outbreaks, deaths, missing persons, disclosure requests); the section 11.2 governance tools
(framework model, evidence library, audits, quality dashboard, PIR prefill, policies, data security
evidence); and the platform pieces the register puts here (single sign-on, the import wizard, the
DSAR workbench and breach register). The ISO 27001 and Cyber Essentials control mapping is drafted
in `docs/compliance/`. Section 19 sets the gate; the 59 Phase 2 rows of the
[feature register](../specs/feature-register.md) set the scope:

| Module | Rows | Count |
| --- | --- | --- |
| Medicines | MEDS-001 to MEDS-008, MEDS-012 to MEDS-014 | 11 |
| Workforce | WORK-001 to WORK-013 | 13 |
| Rostering, time and pay | SCHED-001 to SCHED-012 | 12 |
| Safety | SAFE-006, SAFE-011 to SAFE-016 (SAFE-013 is `partial`: the UKHSA draft exists) | 7 |
| Quality | QUAL-001, QUAL-002, QUAL-004 to QUAL-006, QUAL-008, QUAL-012 | 7 |
| Platform | PLAT-005, PLAT-014, PLAT-022 | 3 |
| Care | CARE-004 (dependency tool) | 1 |
| Integrations | INTG-006, INTG-007, INTG-013 | 3 |
| Mobile | MOB-007, MOB-013 | 2 |

**Mobile is in scope.** The owner unpaused mobile on 31/10/2026, so the eMAR at the point of care
(MOB-007), the offline round with barcode and witness (the gate's Maestro journey) and tablet split
views (MOB-013) are planned here, in lane G.

**Not in Phase 2** (the register's phases): GP proxy ordering (MEDS-009) and the pharmacy interface
(MEDS-010) in Phase 5; home care levels of support (MEDS-011) in Phase 4; Capacity Tracker and
ASC-WDS returns (QUAL-007), registration and governance records (QUAL-010) and surveys (QUAL-011) in
Phase 3; delegated-healthcare governance (QUAL-013) in Phase 5.

**When it starts.** Section 19 starts a phase when the previous gate passes. The Phase 1 gate has
not passed yet ([phase-1-gate.md](phase-1-gate.md): user guides, web screens for 22 rows, the
Maestro journey on iOS). The domain-rule slices (2 to 9) touch only new folders and can start at
once; the rest follow the Phase 1 gate items in [STATUS.md](STATUS.md). Where a Phase 1 item and a
Phase 2 slice touch the same file, the Phase 1 item merges first.

**What needs people** (logged as H-510 to H-549, never blocking): a TRUD account and the dm+d and
SNOMED CT licence terms (H-510, H-511); the CSO's and a pharmacist's decisions on the medicines
rules, the CD register and the MAR exports (H-512 to H-516); payroll provider accounts (H-518,
H-519); vetting providers and the NMC route (H-521 to H-523); the Home Office sponsor rules (H-524);
the DPO's retention periods, lawful bases and DPIAs (H-520, H-525 to H-528, H-544); employment law
readings (H-529); content licences for the Care Certificate, CQC framework wording, policy vendors
and e-learning (H-531 to H-535); Cyber Essentials Plus and ISO 27001 (H-536, H-537); macOS runner
minutes for the iOS simulator gate job (H-542). Pharmacy integrations are built in Phase 5; H-517
starts the lead time for choosing the pharmacy partners now.

## Decisions taken for this phase

**Appendix defaults that apply** (already recorded; section 20 rule 2):

| ADR | Default in force | What it means for Phase 2 |
| --- | --- | --- |
| [0012](../decisions/0012-emar-build.md) | Build the eMAR in Phase 2; pharmacy feeds behind an adapter | Lane A builds the eMAR; pharmacy order, MAR import and label data stay behind a port with a mock until Phase 5 |
| [0013](../decisions/0013-payroll-partner.md) | Xero Payroll first | Slice 76 builds the Xero Payroll adapter first; Staffology, Sage and BrightPay get file exports behind the same port |
| [0022](../decisions/0022-sponsor-licence-module-timing.md) | Sponsor module stays in Phase 2 | Slice 35 builds it; it moves to Phase 3 only if Brian says no first client sponsors workers (H-52, H-524) |
| [0015](../decisions/0015-nhs-dscr-assurance.md) | Pursue assurance; start ISO 27001 in Phase 2 | Slice 80 drafts the ISO 27001 control mapping (H-41, H-537) |
| [0020](../decisions/0020-company-set-up.md) | Company set-up items as human actions | Slice 80 drafts the Cyber Essentials evidence the gate asks for (H-40, H-536) |
| [0011](../decisions/0011-offline-window-and-kiosk-lock.md) | 7-day offline window; 30-second kiosk lock | Recent administrations sync for `mobile.offline_window_days`; MAR reference data for assigned people is never evicted |
| [0004](../decisions/0004-first-target-segment.md) | Residential first | Residential and nursing medicines first; home care levels of support wait for Phase 4 |
| [0006](../decisions/0006-clinical-safety-officer.md), [0007](../decisions/0007-data-protection-officer.md) | Build the safety and data-protection artefacts; sign-off gates go-live | Safety case v0.2 and the DPIA Phase 2 section are drafted (slices 84 and 85); signatures are human actions |

ADRs already recorded that bind Phase 2: [0002](../decisions/0002-tenancy-and-row-level-security.md)
(tenancy and RLS), [0024](../decisions/0024-licence-allowlist.md) (barcode, SCORM and OCR libraries
must be on the allowlist), [0025](../decisions/0025-shared-device-sign-in.md) (eMAR on shared
tablets; proposed), [0029](../decisions/0029-mobile-offline-stack.md),
[0031](../decisions/0031-document-storage-scanning-and-destruction.md) (DBS, right-to-work and policy
uploads), [0033](../decisions/0033-incident-scope.md) (safeguarding and medication errors follow
incident scope; proposed), [0071](../decisions/0071-data-scope-is-per-permission.md) (every new permission has
its own scope) and [0072](../decisions/0072-mfa-counts-only-for-the-session-that-used-it.md) (step-up
for controlled drugs).

**New ADRs.** Each open item below takes the default shown, recorded as an ADR by the slice that
first needs it (the `adr` skill), and the build continues. The numbers in the table below were
the first allocation; since 01/11/2026 ADR numbers are given out at assignment, by the lead, and
the ones in use are listed under "Numbers in use" below.

| ADR | Decision | Default to take | Written by slice | Reviewed by |
| --- | --- | --- | --- | --- |
| 0080 | dm+d reference data: source, licence, refresh and the device subset | The NHSBSA dm+d release from TRUD, loaded into global reference tables with no `tenant_id` (like `bank_holiday`), refreshed monthly as section 15.3 says, with a manual run; tests and development use a small fixture; each device holds only the products on its assigned people's MARs and their GTINs. Records that INTG-006 is Phase 2 in the register although section 19 lists "dm+d sync" under Phase 5, because barcode checks need it | 10 | Security |
| 0081 | Barcodes and positive identification | Packs: GS1 DataMatrix (GTIN, expiry, batch, serial) and linear GTIN barcodes, matched to the MAR entry's dm+d pack or product; a mismatch blocks the record unless an override reason is given. People: a wristband carrying an opaque Harbour token (never the NHS number) or photo confirmation, chosen per person (H-512) | 22 | CSO, security |
| 0082 | Medicines rules at the medical-device boundary | Time-critical and minimum-interval rules (`medicines.paracetamol.min_interval_hours`, `medicines.bisphosphonate.before_food_minutes`, Parkinson's medicines) apply to MAR entries a person tags at transcription, second-checked, never by automatic ingredient matching. Allergies are shown beside the medicine with no automated allergen matching (boundary section 6). The time-critical list and the psychotropic list for the PRN report are tenant-maintained | 3 | CSO, pharmacist (H-514) |
| 0083 | Controlled drugs register | One page per person, drug, form and strength; append-only entries with no UPDATE or DELETE grant; running balance stored on every entry and checked against the previous one; a margin correction is a new entry that references the one it corrects, shown beside it; two distinct signatures with step-up; a stock-check discrepancy raises an incident | 34 | CSO, pharmacist (H-516), security |
| 0084 | Witnesses and second signatures | The witness is a second signed-in member: on the web a second step-up, on a device the witness unlocks with their own enrolled factor on the same device, re-verified by the server on sync; one person can never be both; "no witness available" only where tenant policy allows, flagged for manager review (10.3) | 34 | Security, CSO |
| 0085 | Competence gating across modules | Workforce owns competence and publishes changes on the outbox; medicines and scheduling read it through a published port in the API and the member's own competence rows on the device, never through a cross-module join; an expired competence blocks the action unless a holder of `medicines.override.approve` records an override, which is logged and reported | 17 | CSO, security |
| 0086 | Pay rules engine | Pure functions in `packages/domain/src/scheduling` over stored inputs (timesheet entries, the pay rule set version, the rate rows in force); versioned pay rule sets per tenant; money in whole pence; every result carries its working and an input hash so it reproduces exactly; figures only from `rate_table` | 6 | Security |
| 0087 | Employment law not yet in force | Guaranteed hours, short-notice cancellation payments and shift notice (Employment Rights Act 2025) are "ready": Harbour records hours, offers, notice given and cancellations, but calculates no entitlement and holds no figure until the regulations commence and rates.md has the rows | 6 | Employment adviser (H-529) |
| 0088 | Rota-derived scope and agency access | An agency or bank worker's access comes from their booked shifts and ends at shift end plus `access.agency.post_shift_hours`; no shift, no access. Team scope from the rota (HZ-011) is a tenant setting, off by default, until reviewed | 27 | Security |
| 0089 | Restricted silos: whistleblowing and casework | Separate permissions and RLS policies that no wider role reaches; an anonymous concern stores no reporter identity and its audit event records the action against an anonymous actor, with a reply token for two-way contact; casework is visible only to named case members | 24 | Security, DPO (H-528) |
| 0090 | DSAR workbench and disclosure packs | One collector over the export catalogue with a subject map per table, used by DSARs (slice 15) and disclosure requests (slice 41); third-party redaction by a person, with names from contacts and staff highlighted, never automated; the existing `quality.dsar.manage` permission is kept rather than renamed | 15 | DPO, security |
| 0091 | Single sign-on | The Better Auth SSO plugin (SAML 2.0 and OIDC), so no new sub-processor; linking only to invited members by verified domain; Harbour's own second factor is still needed for care-record permissions | 33 | Security |
| 0092 | Import wizard | Staged rows in quarantine tables, mapping against data-standards.md, a dry run with a validation report, commit by batch with idempotency, undo of a batch within a set window; imported medicines are "not yet checked" (HZ-005) | 26 | CSO, DPO |
| 0093 | E-learning runtime | An allowlisted SCORM 1.2 and 2004 runtime in a sandboxed iframe on a separate origin; xAPI statements kept in Harbour (no external learning record store); no course content shipped | 43 | Security |
| 0094 | Vetting and identity integrations | Manual entry with uploaded evidence is the default; ports for an IDSP, DBS e-bulk and Update Service checks and the NMC register, with mocks and contract tests, switched on per tenant when a provider is contracted | 77 | DPO |
| 0095 | OCR and e-signature adapters | Server-side OCR with an allowlisted engine in europe-west2 ([ADR-0098](../decisions/0098-production-on-google-cloud.md)); OCR output is always a draft that a person checks (HZ-005); DocuSign optional and off by default | 79 | CSO, DPO |
| 0096 | Compliance framework content | CQC's 5 key questions, 34 quality statements and 6 evidence categories seeded as framework version 1 with the source link; tenant mappings versioned; a KLOE-based version added when CQC publishes it | 14 | Quality lead at the design partner (H-533) |
| 0097 | Payroll and pension exports | Only approved timesheets and calculated pay elements leave Harbour, with the fields each provider needs; the tenant's payroll provider is treated as the tenant's own processor unless the DPO decides otherwise (H-520) | 76 | DPO |

**Where the master prompt is ambiguous** (each is carried by the ADR or human action named):

- Section 19 puts "dm+d sync" and the pharmacy interface in Phase 5, while section 15.3 dates dm+d
  sync "2–3", the register puts INTG-006 in Phase 2, and the Phase 2 gate needs barcode checks
  against dm+d. Default: dm+d loads in Phase 2 (ADR-0080); pharmacy feeds stay in Phase 5.
- Section 19's Phase 2 scope cites "10.2" whole, which includes proxy ordering, the pharmacy
  interface and home care levels; the register defers them (MEDS-009 to MEDS-011). The register is
  followed.
- Section 15.3 dates payroll and accounts integrations to Phase 3, while section 19 and the register
  put the payroll export (SCHED-008) in Phase 2. Default: the payroll export in Phase 2, accounting
  sync in Phase 3.
- Section 10.2 asks for paracetamol and bisphosphonate rules with figures Harbour holds, while
  [medical-device-boundary.md](../compliance/medical-device-boundary.md) (its section 3) says the
  interval comes "from the prescription or PRN protocol, not from Harbour", and applying a
  paracetamol rule across products needs ingredient matching, which its section 6 lists as a grey
  area (ADR-0082, H-514).
- "Barcode scan of pack" assumes manufacturer barcodes, but care homes often receive pharmacy-
  dispensed or monitored-dosage packs whose barcodes are the pharmacy's; and residents in care homes
  often do not wear wristbands (ADR-0081, H-512, H-541).
- "Regulator-format MAR chart" (10.2): no regulator prescribes a MAR format. Default: a layout
  following NICE SC1 practice, reviewed by a pharmacist or nurse (H-515).
- Section 5.5 audits every write with its actor, while an anonymous whistleblowing concern must not
  identify its reporter (ADR-0089, H-528).
- The DSAR and breach registers are a platform row (PLAT-022, section 5.1), but the permission in the
  catalogue is `quality.dsar.manage` and section 11.2 lists them under data security evidence.
  Default: platform owns the tables, the permission name stays (ADR-0090).
- The sponsor salary floor (£25,000 in section 12.1) and "3-month switching evidence" are undefined
  or changing; both rows in rates.md are marked to verify (H-524).
- "Holiday accrual at 12.07%" applies only to irregular-hours and part-year workers in leave years
  from 1 April 2024; "SSP from day one at the lower of 80% of earnings or the statutory rate" has
  no Northern Ireland row (rates.md notes). The rules apply only where the rate table has a row for
  the nation (H-529).
- "Guaranteed-hours ... ready for 2027" has no regulations yet (ADR-0087).
- Section 12.3 lists "Workforce returns" (ASC-WDS) but the register puts it with Capacity Tracker in
  Phase 3 (QUAL-007). The register is followed; Phase 2 keeps the fields ASC-WDS will need.

**Rate table.** Every figure Phase 2 uses is read from `rate_table` through a `rates.ts` per module
(as `packages/domain/src/care/rates.ts` does), never as a literal. Rows already in
[rates.md](../specs/rates.md): `nmw.*`, `ssp.*`, `holiday.*`, `wtr.*`, `awr.qualifying_weeks`,
`auto_enrolment.*`, `sponsor.*`, `training.*`, `competence.medicines.refresh_months`,
`supervision.per_year`, `appraisal.per_year`, `document_expiry.reminder_days.*`,
`nmc.revalidation.*`, `medicines.*`, `sync.clock_drift_flag_minutes`,
`access.agency.post_shift_hours`, `dsar.*`, `ico.breach.report_hours`, `dp_complaint.acknowledge_days`
and `dspt.submission_deadline.*`. Rows the slices add, each with its source and status, values taken
from the source when the slice is written (never from this plan):

- Statutory, from gov.uk: the NMW age-band and apprentice thresholds (so 18, 21 and the apprentice
  conditions are never literals), the young-worker age for `wtr.young_worker.*`, the auto-enrolment
  minimum age, statutory maternity, paternity, shared parental, adoption and parental bereavement
  pay and their earnings percentages, and carer's leave and parental bereavement leave entitlements
  (slice 6).
- Tenant defaults with no statutory figure, marked `to-verify`: time-critical late and early windows
  (slice 3, H-513), the CD stock-check interval and the PRN outcome check (slice 3), the dm+d refresh
  interval (slice 10), complaint acknowledgement and response targets (slice 7; Regulation 16 sets
  none for independent providers), the DBS Update Service check interval (slice 4), the lone-worker
  overdue window (slice 46), the rota publishing notice (slice 21), the import undo window (slice 9).
- Not added until the law commences (ADR-0087): Employment Rights Act 2025 guaranteed hours, shift
  notice and cancellation figures. Northern Ireland employment rows wait for the Phase 7 nation pack.

The sleep-in flat allowance, enhancements and mileage rates are the tenant's pay rule set, not the
rate table.

## Work plan (pull requests in order)

Each slice follows the section 19 order (schema and domain rules first, then API, web, mobile,
integrations, documentation) and lands as its own pull request of about 2,000 changed lines or fewer
including tests (generated migration snapshots, `openapi.json` and the generated client not
counted); a slice that grows larger splits at the point its row names. Every slice updates its spec,
its register rows, its hazards and its data-protection documents in the same pull request
(section 20 rule 7) and adds a `docs/changelog-dev/` file.

### Lanes and shared files

Slices in different lanes can be built at the same time by different workers. A lane owns its
schema files, domain folder, route files, web routes and tests; no lane edits another lane's tables
or files.

| Lane | Owns | Schema files |
| --- | --- | --- |
| A Medicines | `packages/domain/src/medicines`, `apps/api/src/routes/medicines-*.ts`, web medicines routes, `docs/specs/medicines.md` | `medicines.ts`, `dmd.ts` |
| B Workforce | `packages/domain/src/workforce`, `apps/api/src/routes/workforce-*.ts`, web staff routes, `docs/specs/workforce.md` | `workforce.ts` |
| C Scheduling | `packages/domain/src/scheduling`, `apps/api/src/routes/scheduling-*.ts`, web rota routes, `docs/specs/scheduling.md` | `scheduling.ts`, `dependency.ts` (CARE-004, so `care.ts` is untouched) |
| D Safety | new files under `packages/domain/src/safety`, new safety route files, `docs/specs/safety.md` Phase 2 sections | `safeguarding.ts`, `complaints.ts`, `whistleblowing.ts`, `safety-records.ts` (never `safety.ts`) |
| E Quality | new files under `packages/domain/src/quality`, `docs/specs/quality.md` Phase 2 sections, `docs/compliance/cyber-essentials.md`, `docs/compliance/iso27001-controls.md` | new `quality-*.ts` files (framework, audits, indicators, data security evidence) and `policies.ts`; never the Phase 1 `quality.ts` tables |
| F Platform | new files under `packages/domain/src/platform`, `docs/specs/platform.md` Phase 2 sections, the DPIA template | `data-rights.ts`, `imports.ts`, `sso.ts` |
| G Mobile | `apps/mobile`, `packages/sync` (stream definitions), `packages/ui-native` | none |
| H Integrations | `packages/domain/src/integrations/ports.ts`, `apps/api/src/integrations/`, `docs/specs/integrations.md` | the payroll export record in `integrations.ts` |

Lanes A to F never edit `packages/sync/src/streams/sync-config.yaml` (lane G does) or the
integration ports and adapters (lane H does); a schema slice adds its tables to the PowerSync
publication in its own migration. Cross-lane needs go through a published port or an outbox event,
never an edit to the other lane's files (for example slice 22 reads competence through slice 17's
port; slice 31 links IPC audits to the templates slice 19 seeds; slice 47 consumes events the source
slices publish).

**Shared files** every lane touches: the register rows, `STATUS.md`, the hazard log, the records of
processing, `data-standards.md`, `rates.md`, `retention.md`, `human-actions.md`, the ADR index,
`packages/db/src/schema/index.ts`, `packages/domain/src/platform/export-catalogue.ts`,
`permissions.ts` and `roles.ts` (and the generated `permissions.md`), route registration in
`apps/api/src/app.ts`, the i18n catalogues and the web navigation. Rules: add in the lane's own
section or key namespace (`medicines.*`, `workforce.*`, `scheduling.*` and so on); take both sides
on a conflict; regenerate `openapi.json`, the typed client, `permissions.md` and the migration
journal after merging `main`, never hand-merge them.

**Migrations** merge in number order (STATUS, ways of working), one migration per schema slice with
its security SQL in the same file (the pattern since 0054). The first allocation (0072 to 0110)
no longer holds: slices that merged late moved to higher numbers, and the numbers they left
(0072, 0078, 0084, 0089, 0090, 0092, 0096, 0098, 0100 and 0102) are never reused; the migration
journal allows the gaps. **Numbers are now given out at assignment**, by the lead, with the
branch; two slices never share a number. The "Migration" column below shows the number each slice
uses on `main` or on its branch.

**Numbers in use** (read from every branch on 01/11/2026; anything not listed is assigned to work
not yet pushed):

| Migration | What | Branch |
| --- | --- | --- |
| 0104 | Bank and agency workers (slice 27) | `feat/sched-bank-agency` |
| 0107 | Absence and leave (slice 40) | `feat/sched-absence-leave` |
| 0108 | Quality indicators (slice 47) | `feat/quality-dashboard-pir` |
| 0109 | Time and attendance (slice 30) | `feat/sched-time-attendance` |
| 0110 | dm+d reference data (slice 10) | `feat/meds-dmd-reference` |
| 0111 | Medicines record (slice 16) | `feat/meds-record-schema` |
| 0112 | E-learning runtime (slice 43) | `feat/work-elearning` |
| 0113 | Lone-worker safety (slice 46) | `feat/sched-lone-worker` |
| 0114 | Supervision notes (slice 17 follow-up) | `feat/web-training-competence` |
| 0115 | Staff wellbeing (slice 44) | `feat/sched-wellbeing` |
| 0116 | Pay calculation runs (slice 36) | `feat/sched-pay-runs` |
| 0117 | Per-organisation crypto-shredding (PLAT-012) | `feat/platform-crypto-shred` |
| 0118 | Incident contacts not known (recommended answers) | `fix/recommended-answers-care` |
| 0120 | Vetting adapters (slice 77) | `feat/work-vetting-adapters` |
| 0121 | Recommended answers | `feat/work-vetting-adapters`, `feat/web-workforce-people` |
| 0122 | Recommended answers (safety) | `fix/recommended-answers-safety` |
| 0123 | Medicine administrations (slice 22) | `feat/meds-administration-schema` |
| 0124 | Disclosure hand-over (slice 41 follow-up) | `feat/web-safety-events` |
| 0125 | Staff privacy notice document (slice 35 follow-up) | `feat/web-staff-file` |
| 0127 | Payroll and pension exports (slice 76) | `feat/sched-payroll-export` |
| 0128 | Controlled drugs register (slice 34) | `feat/meds-cd-register` |
| 0129 | Member lifecycle security | `fix/recommended-answers-platform` |
| 0130 | Crypto-shred refusals | `feat/web-retention-shred` |
| 0131 | The dm+d job's own role (slice 75) | `feat/integrations-dmd-download` |
| 0137 | Built-in role backfill (workforce grants, speak-up and employee relations roles) | `chore/phase-2-cleanups` |
| 0105, 0106, 0119, 0126, 0132 to 0136 | Assigned; not on any branch yet | - |

| ADR | What | Where |
| --- | --- | --- |
| 0098 | Production on Google Cloud | `main` |
| 0099 | Never-overridable DBS and registration checks | `feat/sched-absence-leave` |
| 0108 | Quality indicator counts | `feat/quality-dashboard-pir` |
| 0109 | Per-organisation crypto-shredding | `feat/platform-crypto-shred` |
| 0114 | Supervision notes kept in Harbour | `feat/web-training-competence` |
| 0125 | Speak-up: anonymised view not yet granted | `fix/safety-gaps-from-guides` |
| 0100 to 0107, 0110 to 0113, 0115 to 0124 | Assigned; not on any branch yet | - |

**Reserved numbers.** Hazards HZ-113 to HZ-130 are assigned below and HZ-131 to HZ-139 are spare for
Phase 2; DPIA risks R20 to R29 are assigned and R30 onwards spare. Human actions are given out in
blocks at assignment, like migrations and ADRs (the first blocks by lane were A H-550 to H-569, B
H-570 to H-579, C H-580 to H-589, D H-590 to H-599, E H-600 to H-609, F H-610 to H-619, G H-620 to
H-629, H H-630 to H-639 and the gate H-640 to H-649).

### Slices

In section 19 order: slices 2 to 9 are domain rules (no schema), 10 to 51 schema and API (in
migration order, then the API-only slices), 52 to 67 web, 68 to 74 mobile, 75 to 79 integrations
and 80 to 85 documentation. "Depends on" lists the slices whose code or decisions a slice needs;
the migration numbers also fix the merge order of the schema slices. A slice may start against a
contract-tested mock of a port that has not merged yet (section 20 rule 2), but merges only after
the slices it depends on.

| # | Slice | Lane | Register rows | Content | Migration | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Plan and stub specs | - | - | This plan; stub specs `medicines.md`, `workforce.md`, `scheduling.md`, `integrations.md`; human actions H-510 to H-549 | - | - |
| 2 | Medicines record and dose rules | A | MEDS-001 | `medicines.md` written in full (schema, permission matrix, rules, test list). Domain: structured dose (a number and a unit permitted for the dm+d product; leading zero, no trailing zero, micrograms, nanograms and units in full); schedules as wall-clock times expanded over a 28-day cycle in Europe/London (`medicines.ordering_cycle_days`); non-daily schedules name the day; MAR entry states ("not yet checked" until a second competent user checks it); reconciliation (sources, completer, outcome per medicine) | - | 1 |
| 3 | Administration, PRN and controlled-drug rules | A | MEDS-002, MEDS-003, MEDS-005, MEDS-013 | Outcomes and coded reasons; refuse without person, dose and outcome; a duplicate within the minimum interval needs an override reason, measured in elapsed time on the drift-corrected clock; PRN maximum in 24 hours and last given; time-critical lateness from tenant rules (ADR-0082); closing a round with outstanding doses; CD page key, running balance, correction entries and the witness rule per tenant policy; competence as an input (`competence.medicines.refresh_months`); MAR row lock once synced | - | 2 |
| 4 | Workforce compliance, training and competence rules | B | WORK-002, WORK-003, WORK-005, WORK-008, WORK-009, WORK-012 | `workforce.md` in full. Schedule 3 checklist per role; expiry tasks at `document_expiry.reminder_days.*`; right-to-work re-check; DBS risk assessment before clearance; employment-history gaps by month; training RAG (`training.*`); competence validity; supervision and appraisal schedules; NMC revalidation (`nmc.revalidation.*`); sponsor change reports in working days and the salary floor check (`sponsor.*`); the rule that a worker without a required check cannot be rostered | - | 1 |
| 5 | Working time rules | C | SCHED-003 | `scheduling.md` in full. 48-hour average over the reference period with opt-outs, daily and weekly rest, breaks, night work and young workers (`wtr.*`); only sleep-in time awake for the purposes of working counts for NMW; travel time between visits counts as working time; table-driven | - | 1 |
| 6 | Pay rules: NMW, holiday, SSP and agency | C | SCHED-005, SCHED-006, SCHED-007, SCHED-009, SCHED-010 | Pay rule sets (rates by role, enhancements, sleep-in flat rate, mileage, on-call); NMW per pay reference period with travel time, uniform deductions and the accommodation offset (`nmw.*`); holiday accrual for irregular-hours workers and itemised rolled-up holiday pay (`holiday.*`); SSP from day one at the lower of the earnings percentage and the weekly rate (`ssp.*`); AWR clock (`awr.qualifying_weeks`); auto-enrolment flags (`auto_enrolment.*`); Bradford factor; the new rate rows; the gate's rule tables (ADR-0086, ADR-0087) | - | 5 |
| 7 | Safety Phase 2 rules | D | SAFE-006, SAFE-011, SAFE-012, SAFE-014, SAFE-015, SAFE-016, MEDS-012 | `safety.md` Phase 2 sections. Safeguarding states (concern, s.42 referral, enquiry, Making Safeguarding Personal outcome, DBS referral decision); complaints with tenant SLA clocks, appeal and LGSCO signposting; whistleblowing states; expected and unexpected deaths and mortality review; missing-person timeline and return check; disclosure types with legal basis and an approver who is not the requester; classifier questions for medication errors, so lane A never edits the classifier | - | 1 |
| 8 | Quality Phase 2 rules | E | QUAL-001, QUAL-002, QUAL-004, QUAL-005, QUAL-006, QUAL-008, QUAL-012 | `quality.md` Phase 2 sections. Framework versions, with historical audits kept on the version they were scored against; scored audits and self-rating 1 to 4; indicator definitions with the method shown and RAG against tenant targets, missing data never shown as good; PIR data points; policy versions and read-and-sign by role; the DSPT deadline (`dspt.submission_deadline.*`) | - | 1 |
| 9 | Platform Phase 2 rules | F | PLAT-005, PLAT-014, PLAT-022 | `platform.md` Phase 2 sections. DSAR clock with extension and pauses (`dsar.*`); breach 72-hour clock (`ico.breach.report_hours`) and severity; data-protection complaint acknowledgement (`dp_complaint.acknowledge_days`); import validation against `data-standards.md` (NHS number check digit, coded fields, dd/mm/yyyy dates); SSO linking only to invited members | - | 1 |
| 10 | dm+d reference data | A | MEDS-001, INTG-006 | Global reference tables without `tenant_id` (VTM, VMP, AMP, VMPP, AMPP, GTIN, and lookups for units, forms, routes and CD schedules); release loader for the NHSBSA XML from a small fixture; release history; search and GTIN lookup API; tables added to the PowerSync publication (ADR-0080) | 0110 | 2 |
| 11 | Staff profile and pre-employment file | B | WORK-002, WORK-011 | `staff_profile` and `compliance_item` (photo ID; right to work with re-check; DBS level, number, barred-list result, Update Service status and risk assessment; employment history and gaps; references and conduct; health declaration; registration and PIN); HR-only documents with audited views; expiry tasks through the task engine | 0073 | 4 |
| 12 | Dependency tool | C | CARE-004, SCHED-001 | Tenant-editable dependency scale (categories with care hours per category, labelled as the tenant's own tool); the person's category and 1:1 hours; required care hours per shift | 0074 | 5 |
| 13 | Safeguarding log | D | SAFE-006 | Concerns, s.42 referrals (from the Phase 1 drafts), LA enquiry outcomes, Making Safeguarding Personal outcomes, DBS referral decisions, the pressure-ulcer decision guide link; clocks feed the notification centre (HZ-013); scope as incidents | 0075 | 7 |
| 14 | Compliance framework and evidence library | E | QUAL-001, QUAL-002 | Framework versions with key questions, quality statements and evidence categories, seeded as version 1 (ADR-0096); tenant mappings versioned; evidence links from any record type, so compliments and audits can be tagged; the evidence pack reads statement ids from here | 0076 | 8 |
| 15 | DSAR workbench | F | PLAT-022, WORK-011 | Cases for people, contacts and staff; identity check; clock with pauses and extension; collection across modules from the export catalogue; third-party redaction by a person; bundle; rectification, erasure where retention allows, portability (ADR-0090) | 0077 | 9 |
| 16 | Medicines record and reconciliation | A | MEDS-001 | `medication` and `medication_schedule` (dm+d code, strength, form, dose, frequency, route, times, start, stop, review, prescriber, indication, special instructions, schedule type, CD schedule); second check; source document; reconciliation on admission, transfer, change and return from hospital (with the PEOP-010 return checks); an `import` origin for slice 51; history and audit | 0111 | 3, 10 |
| 17 | Training, competence and supervision | B | WORK-005, WORK-008, WORK-009, WORK-012 | Training requirements per role, training records, observed competence sign-offs, supervisions, appraisals and spot checks, qualifications and the revalidation planner; competence events on the outbox and the competence port (ADR-0085) | 0079, 0114 | 11 |
| 18 | Complaints and compliments | D | SAFE-011 | Reg 16 workflow: acknowledgement, investigation, response within the tenant SLA, outcome, appeal, LGSCO signposting; compliments as evidence through slice 14's links | 0080 | 7 |
| 19 | Audit programme and mock inspections | E | QUAL-004 | Scored audit templates mapped to the framework (medication, care plans, IPC, environment, dignity, night visit, mock inspection), schedules, findings, self-rating, actions into the task engine; seeds the IPC template slice 31 uses | 0081 | 14 |
| 20 | Breach register and data-protection complaints | F | PLAT-022 | Breaches with the 72-hour clock, severity, notice to data subjects from a template, ICO reference; Thapsus-to-tenant notice in-app; data-protection complaints with the acknowledgement clock and outcome | 0082 | 9 |
| 21 | Shifts, rota builder and staffing comparison | C | SCHED-002, SCHED-001 | Shift templates and patterns, open shifts, assignments, swaps with approval, publishing with notice tracking; eligibility (DBS, right to work, competence) with a logged manager override; rota hours and skill mix against the dependency requirement, with the method shown. Split point: the staffing comparison | 0083 | 5, 11, 12, 17 |
| 22 | Administrations | A | MEDS-002 | Append-only `medication_administration` (client UUID, due time, outcome, reason, dose, by, witness, scan evidence, covert flag, patch site, stock after, device and server time, `supersedes_id`); every 10.3 rule enforced in the API; MAR row lock and referenced corrections; the competence gate through slice 17's port (a contract-tested mock until it merges); barcode match (ADR-0081) | 0123 | 16, 17 |
| 23 | Applicant tracking | B | WORK-001 | Job templates by Care Workforce Pathway role, vacancies, applications, shortlisting, interviews with values-based questions, offers, talent pool; an accepted offer creates the staff profile | 0085 | 11 |
| 24 | Whistleblowing and speak-up | D | SAFE-012 | Named or anonymous concerns to the Freedom to Speak Up lead in a separate RLS silo, reply without identity, outcome tracking (ADR-0089) | 0086 | 7 |
| 25 | Policy library and read-and-sign | E | QUAL-008 | Policies and versions with review dates, read-and-sign by role with reminders, change log, vendor PDF and structured import, starter templates (CCTV with camera and signage register, social media, photography and image consent, AI use) as drafts for the tenant | 0087 | 8 |
| 26 | Import wizard | F | PLAT-014 | Batches and staged rows, CSV and JSON mappings, dry run and validation report, commit with idempotency, undo of a batch; people, contacts, allergies (with allergy status) and staff; round trip with the full export (HZ-071) (ADR-0092) | 0088 | 9 |
| 27 | Bank and agency workers | C | SCHED-009 | Agencies and workers, bookings, AWR clock, cost, induction-at-location checks, feedback; agency access ends at shift end plus `access.agency.post_shift_hours` (ADR-0088) | 0104 | 21 |
| 28 | PRN protocols and the psychotropic report | A | MEDS-003 | Versioned PRN protocols (indication, dose, maximum daily, minimum interval, triggers, non-drug alternatives, order of use, review date); outcome follow-up; the tenant's psychotropic list and the PRN frequency report | at assignment | 22 |
| 29 | Onboarding, Care Certificate and leavers | B | WORK-004, WORK-013 | Care Certificate (16 standards) progress with assessor sign-off, shadow shifts, probation reviews, policy read-and-sign; leaver checklist, references, staff file retention | 0091 | 23, 25 |
| 30 | Time and attendance and working-time records | C | SCHED-004, SCHED-003 | Append-only clock events (device and server time; geofence or NFC evidence at clock-in only), exceptions, timesheet approval by someone other than the worker, mileage, sleep-in awake periods; working-time results stored; opt-outs on file | 0109 | 5, 21 |
| 31 | Outbreaks and IPC audits | D | SAFE-013 | Case line list, declaration, UKHSA report fields (completing the Phase 1 draft), closure; IPC audits against the Code of Practice criteria on slice 19's template | 0093 | 7, 19 |
| 32 | Data security evidence | E | QUAL-012 | DSPT assertion tracker with evidence uploads and the 30 June deadline, Cyber Essentials and ICO registration records, links to the breach and DSAR registers | 0094 | 8, 20 |
| 33 | Single sign-on | F | PLAT-005 | SAML and OIDC per tenant, domain verification, linking to invited members only, Harbour's second factor for care records (ADR-0091) | 0095 | 9 |
| 34 | Controlled drugs register | A | MEDS-005 | Pages per person, drug, form and strength; append-only entries (receipt, administration, disposal, transfer, destruction with witness); running balance; margin corrections as linked entries; two signatures with step-up; patch site rotation; stock checks; a discrepancy raises an incident (ADR-0083, ADR-0084) | 0128 | 22 |
| 35 | Sponsor licence, staff data protection and LDSS | B | WORK-003, WORK-011, WORK-007 | Sponsored-worker record (CoS, visa expiry, Appendix D documents, absence monitoring, change reports, English language and switching evidence), HR-only; staff privacy notice; staff photo and image consent; staff DSARs through slice 15; LDSS claim tracking | 0097, 0125 | 11, 15 |
| 36 | Pay calculation runs | C | SCHED-005, SCHED-006, SCHED-007 | Versioned pay rule sets per tenant; calculation runs that store inputs and working and reproduce exactly; NMW results per pay reference period; holiday accrual ledger; SSP periods; guaranteed-hours and cancellation records for readiness | 0116 | 30, 6 |
| 37 | Deaths and missing persons | D | SAFE-014, SAFE-015 | Expected and unexpected death workflow, mortality review, notifications (with the Phase 1 medical examiner pack and LeDeR prompt); Herbert Protocol profile prefilled from the record, police reference and timeline, search log, return welfare check, debrief | 0099 | 7 |
| 38 | Covert, self-administration and homely remedies | A | MEDS-004, MEDS-006, MEDS-007 | Per-medicine covert record linked to the capacity and best-interests records (attendees including pharmacist and prescriber, method, review), covert doses marked on the MAR; self-administration assessment (choice, capacity, dexterity, storage) and review; homely remedy protocols (product, indication, dose, maximum daily, duration before GP referral, authorised staff) | at assignment | 22 |
| 39 | Employee relations casework | B | WORK-010 | Disciplinary, grievance, capability, sickness absence, suspension and probation cases with investigation, hearing, outcome, appeal and timelines following the ACAS Code; restricted silo (ADR-0089); DBS barring and regulator referral decisions linked to the safeguarding log | 0101 | 11, 13 |
| 40 | Absence and leave | C | SCHED-010 | Requests and approvals, Bradford factor, return to work, fit notes, SSP eligibility, statutory family leave (maternity, paternity, parental, bereavement, carer's leave) | 0107 | 6, 21 |
| 41 | Disclosure requests | D | SAFE-016 | Coroner disclosure and inquest packs with the Regulation 28 response tracker, SAR and DHR chronologies, police and solicitor disclosure under DPA 2018 Schedule 2, Access to Health Records Act 1990 requests, disclosure log with legal basis and approver; collection through slice 15 | 0103, 0124 | 7, 15 |
| 42 | Stock, ordering, disposal and temperatures | A | MEDS-008 | Stock per medicine with receipts and returns; 28-day cycle ordering; disposal records; fridge and room temperature logs (`medicines.fridge_*`, `medicines.room_max_celsius`); medicines for leave; creams and patches charted against the body map; "not available" creates a stock task | at assignment | 16, 22 |
| 43 | E-learning runtime | B | WORK-006 | Package upload to the document store, SCORM 1.2 and 2004 and xAPI runtime on a sandboxed origin, statement store, completion into training records (ADR-0093) | 0112 | 17 |
| 44 | Staff wellbeing and voice | C | SCHED-011 | Pulse surveys with a minimum group size before results show, recognition, speak-up link to slice 24, exit interviews, turnover by team | 0115 | 11, 24 |
| 45 | Medication errors and reviews | A | MEDS-012, MEDS-013 | Errors and near misses on the incident with medicines details (severity, harm, immediate actions, prescriber informed, root cause), CQC and safeguarding decisions through slice 7's classifier questions, trend report; annual medication review tracker (`medicines.review_interval_months`); competence override log and report | at assignment | 22, 17, 7 |
| 46 | Lone-worker safety | C | SCHED-012 | Scheduled check-ins, overdue alarm to on-call through escalation chains, panic button, incident link | 0113 | 21 |
| 47 | Quality dashboard and PIR prefill | E | QUAL-005, QUAL-006 | Indicators by location (falls per 1,000 bed-days, pressure ulcers, medication errors, overdue reviews, training compliance, agency hours, complaints, turnover, incident response times) with the method shown and RAG against tenant targets, from events the source slices publish; PIR data points in the CQC question set for the manager to copy | 0108 | 14, 17, 18, 27, 45 |
| 48 | Rounds, escalation and conflict review | A | MEDS-002 | Round view by time slot; late and early warnings; time-critical escalation that a tenant cannot switch off (HZ-008); closing a round; a conflict review task when two devices record one dose (HZ-004); alert volume and override metrics | - | 22 |
| 49 | Medicines in the Phase 1 outputs | A | MEDS-001, MEDS-002 | Outstanding doses in the handover; doses due in the downtime pack (HZ-021, H-102); transfer pack medicines from the eMAR (HZ-023, H-82); how care plan medicines actions relate to rounds (H-151). Touches care, people and operations files: merge after the Phase 1 web items on them | - | 48, 16 |
| 50 | Printable MAR and CD register | A | MEDS-014 | MAR chart per person per month (allergy section, codes key, covert marks, printed time, "not the live record") and CD register page exports as PDFs | - | 48, 34, 38 |
| 51 | Import of medicines, care plans and staff files | F | PLAT-014, WORK-013 | Imported medicines arrive "not yet checked" through slice 16's import origin (HZ-005); care plans as drafts; staff files; TUPE transfer between group tenants | - | 26, 16, 11 |
| 52 | Web: medicines record, reconciliation and self-administration | A | MEDS-001, MEDS-006 | Medicines tab on the person record; dm+d picker; second check; reconciliation; self-administration assessments; Playwright and axe | - | 16, 38 |
| 53 | Web: rounds, administration, PRN and covert | A | MEDS-002, MEDS-003, MEDS-004 | Round view for the office and tablet browser; administration with allergies beside the medicine (HZ-007); PRN with last given; covert marks | - | 48, 28, 38 |
| 54 | Web: controlled drugs register and exports | A | MEDS-005, MEDS-014 | Register pages, entries, witness, stock checks; MAR and CD register exports (HZ-007 printed MAR test) | - | 34, 50 |
| 55 | Web: stock, temperatures, homely remedies, errors and reviews | A | MEDS-007, MEDS-008, MEDS-012, MEDS-013 | Stock and ordering, temperature logs, homely remedy protocols, errors and trend report, review tracker, overrides report | - | 42, 45, 38 |
| 56 | Web: staff file, compliance and sponsor | B | WORK-002, WORK-003, WORK-011 | Staff file, compliance checklist and expiries, HR-only documents, sponsored-worker record | - | 11, 35 |
| 57 | Web: training matrix, competence, supervision and e-learning | B | WORK-005, WORK-006, WORK-007, WORK-008, WORK-009, WORK-012 | Matrix with RAG by location and team (status by icon and word), competence sign-offs, supervision scheduler, LDSS claims, revalidation, the e-learning player page | - | 17, 43, 35 |
| 58 | Web: recruitment, onboarding, leavers and casework | B | WORK-001, WORK-004, WORK-010, WORK-013 | Vacancies and applicants, onboarding and Care Certificate, leavers, casework (silo) | - | 23, 29, 39 |
| 59 | Web: rota, agency and staffing planner | C | SCHED-001, SCHED-002, SCHED-009, CARE-004 | Rota builder, swaps, open shifts, agency bookings, dependency scale and the staffing gap with its method | - | 21, 27, 12 |
| 60 | Web: timesheets, working time, pay and absence | C | SCHED-003, SCHED-004, SCHED-005, SCHED-006, SCHED-007, SCHED-010 | Timesheet approval, working-time alerts, pay review with the working shown, holiday and SSP, absence and leave | - | 30, 36, 40 |
| 61 | Web: wellbeing and lone worker | C | SCHED-011, SCHED-012 | Surveys and results, lone-worker check-in board and alarms | - | 44, 46 |
| 62 | Web: safeguarding, complaints and whistleblowing | D | SAFE-006, SAFE-011, SAFE-012 | Safeguarding log, complaints and compliments, the speak-up form and the Freedom to Speak Up lead's view | - | 13, 18, 24 |
| 63 | Web: outbreaks, deaths, missing persons and disclosure | D | SAFE-013, SAFE-014, SAFE-015, SAFE-016 | Outbreak line list and report, death workflow and mortality review, missing-person timeline, disclosure log and packs | - | 31, 37, 41 |
| 64 | Web: framework, evidence library and audits | E | QUAL-001, QUAL-002, QUAL-004 | Framework and mapping editor, evidence tagging, audit programme and mock inspections | - | 14, 19 |
| 65 | Web: policies, dashboard, PIR and data security evidence | E | QUAL-005, QUAL-006, QUAL-008, QUAL-012 | Policy library and read-and-sign, quality dashboard with method shown, PIR prefill, DSPT tracker | - | 25, 47, 32 |
| 66 | Web: DSAR workbench, breaches and data-protection complaints | F | PLAT-022 | DSAR cases with clock and redaction, breach register with the 72-hour clock, data-protection complaints | - | 15, 20 |
| 67 | Web: import wizard and SSO settings | F | PLAT-014, PLAT-005 | Mapping, dry run report, commit and undo; identity provider settings | - | 26, 51, 33 |
| 68 | Medicines sync and the device dm+d subset | G | MOB-007, MEDS-002 | Streams scoped to assigned people for medicines, schedules, PRN protocols, covert flags and recent administrations within the offline window; the dm+d subset and GTINs for those products; the member's own medicines competence; priority stream for allergy and medicine-stopped changes (HZ-002); stream isolation tests | - | 10, 16, 17, 22, 28, 38 |
| 69 | Offline round with barcode and person confirmation | G | MOB-007, MEDS-002, MEDS-003 | Round by time slot; pack scan (GS1 DataMatrix and linear GTIN); wristband token or photo confirmation; allergies beside the medicine; outcomes and reasons; PRN last given and maximum; local reminders for time-critical doses; eMAR disabled on a rooted or jailbroken device; Maestro `hazard-HZ-003-offline-round.yaml` | - | 68, 48 |
| 70 | Controlled drugs offline with a witness, and conflict review | G | MOB-007, MEDS-005 | Witness on the same device (ADR-0084); MAR row lock after sync; referenced corrections; conflict review for the nurse in charge (`hazard-HZ-004-offline-conflict.yaml`); the gate journey on an iOS simulator and an Android emulator | - | 69, 34 |
| 71 | Rota, clock-in and lone-worker check-ins on the phone | G | MOB-007, SCHED-002, SCHED-004, SCHED-012 | Own shifts; queued swap requests; clock in and out with device and server time; NFC or geofence evidence at clock-in only; lone-worker check-ins and panic button | - | 21, 30, 46 |
| 72 | Training offline | G | MOB-007, WORK-006 | Modules downloaded in advance and completed offline; statements queued and sent on sync | - | 43 |
| 73 | Tablet split views | G | MOB-013 | iPad and Android tablet split views for the MAR and the handover, with the point-of-care header in each pane (HZ-001) | - | 69 |
| 74 | Responsive web down to 360 px | G | MOB-013 | Playwright at 360 px for every Phase 1 and Phase 2 screen, with the fixes; runs after the web slices merge | - | 52 to 67 |
| 75 | dm+d release download | H | INTG-006 | Worker job fetching the release from TRUD with credentials from the secret store; checksum; load through slice 10; release history; failure alert (HZ-113); monthly schedule; contract test with a mock TRUD | - | 10 |
| 76 | Payroll and pension exports | H | SCHED-008 | Port `payroll.export`; Xero Payroll UK adapter with per-tenant OAuth; file exports for Staffology, Sage and BrightPay; approved timesheets only; auto-enrolment flags; export records for reproducibility (ADR-0013, ADR-0097) | 0127 | 36 |
| 77 | Identity and vetting adapters | H | INTG-007 | Ports for IDSP right-to-work checks, DBS e-bulk and Update Service status, the NMC register; mocks and contract tests; results stored as compliance items with evidence (ADR-0094) | - | 11 |
| 78 | LMS imports | H | WORK-006 | External training records and xAPI statements imported from an LMS behind a port with a mock | - | 43 |
| 79 | E-signature and OCR adapters | H | INTG-013 | Optional DocuSign adapter behind the existing signature port, off by default; camera scan of paper MARs with server-side OCR producing draft medicines that arrive "not yet checked" through slice 51 (ADR-0095) | - | 51, 16 |
| 80 | Cyber Essentials and ISO 27001 control mapping | E | - | `docs/compliance/cyber-essentials.md` (firewalls, secure configuration, security update management, user access control, malware protection, each with evidence in the repository and `infra/`); `docs/compliance/iso27001-controls.md` (Annex A mapping draft) | - | 1 (can start at once) |
| 81 | User guides: medicines | A | MEDS rows | `docs/user-guides/` sections for the care worker, nurse and Registered Manager; each row links its section | - | 52 to 55, 69, 70 |
| 82 | User guides: workforce and scheduling | B, C | WORK rows, SCHED rows, CARE-004 | Sections for the HR lead, manager and care worker | - | 56 to 61, 71, 72 |
| 83 | User guides: safety, quality and platform | D, E, F | SAFE, QUAL, PLAT, INTG rows | Sections for the Registered Manager, quality lead and data protection lead | - | 62 to 67, 75 to 79 |
| 84 | DPIA Phase 2 | F | - | DPIA template section 7B and risks R20 to R29 in the template and the in-app prefill (`packages/domain/src/platform/dpia.ts` and its test), as Phase 1 did for R13 to R19 | - | 11, 15, 20, 24, 26, 30, 33, 39, 44, 76 |
| 85 | Safety case v0.2 and the Phase 2 gate record | all | - | `docs/plans/phase-2-gate.md`, clinical safety case v0.2 in `docs/clinical-safety/safety-case/`, `docs/demo/` Phase 2 walkthrough, STATUS | - | every slice |

## Hazards expected in this phase

New hazards are added with the `hazard` skill by the first slice named (the CSO rates them; H-513,
H-543). Every test name carries the hazard id.

| ID | Hazard | First slice | Also verified in |
| --- | --- | --- | --- |
| HZ-113 | dm+d reference data out of date, loaded wrongly or missing on a device, so the wrong product, unit or barcode match is shown | 10 | 68, 75 |
| HZ-114 | A barcode scan matched to the wrong product, pack or person | 22 | 69 |
| HZ-115 | A controlled drugs register entry altered, a balance wrong, or a discrepancy not noticed | 34 | 54, 70 |
| HZ-116 | A two-person check (witness, second signature, transcription check) done by one person or not genuinely witnessed | 3 | 16, 34, 70 |
| HZ-117 | A when-required medicine given outside its protocol, without the protocol shown, or without the outcome recorded | 28 | 53, 69 |
| HZ-118 | A medicine unavailable, expired or stored out of range without action | 42 | 55 |
| HZ-119 | Expired competence does not block administration, or the manager override becomes routine | 3 | 17, 22, 45, 69 |
| HZ-120 | Self-administration or a homely remedy continued without a current assessment or outside its protocol | 38 | 52, 55 |
| HZ-121 | Medicines not reconciled after admission, transfer or return from hospital, so a stopped medicine continues or a new one is missed | 2 | 16, 49, 52 |
| HZ-122 | A printed MAR or CD register export out of date, incomplete or taken for the live record | 50 | 54 |
| HZ-123 | Staffing below the tenant's assessed need or skill mix without a visible warning | 12 | 21, 59 |
| HZ-124 | A worker without a required check, training or competence rostered to a shift that needs it | 4 | 21, 27, 59 |
| HZ-125 | A lone worker's missed check-in or panic alarm not escalated | 46 | 61, 71 |
| HZ-126 | A safeguarding concern not progressed, or protective measures not visible to the staff caring for the person | 13 | 62 |
| HZ-127 | A missing person's escalation delayed, or the Herbert Protocol profile out of date | 37 | 63 |
| HZ-128 | Staff follow a superseded policy or procedure | 25 | 65 |
| HZ-129 | A quality indicator or audit score falsely reassures (missing data shown as good, a wrong denominator) | 47 | 65 |
| HZ-130 | Imported records mis-mapped, duplicated or attached to the wrong person | 26 | 51, 67, 79 |

Existing hazards that gain their Phase 2 controls and tests (the planned rows already in the log):

| ID | Phase 2 controls | Slices |
| --- | --- | --- |
| HZ-001 | Wristband scan or photo confirmation per administration; point-of-care header in every split-view pane | 22, 69, 73 |
| HZ-002 | Last-given time shows its source; priority stream for allergy and medicine-stopped changes; a dose given offline from a medicine stopped meanwhile goes to the conflict review | 68, 69, 70 |
| HZ-003 | Round view, outstanding doses, time-critical escalation, round closing, "not available" task, local reminders, eMAR disabled on a rooted device | 3, 22, 48, 69 |
| HZ-004 | Duplicate blocked within the interval, PRN maximum, MAR row lock, conflict review, no UPDATE or DELETE grant | 3, 22, 48, 70 |
| HZ-005 | dm+d-only selection, structured dose, second check, source document, imports and OCR "not yet checked" | 2, 16, 51, 79 |
| HZ-007 | Allergies beside the medicine (no automated matching, ADR-0082); printed MAR allergy section; import dry run lists people without an allergy status | 22, 26, 50, 53 |
| HZ-008 | Time-critical escalation cannot be switched off; monthly alert volume and override report | 48 |
| HZ-009 | Doses on clock-change days; intervals in elapsed time | 2, 3 |
| HZ-010 | Interval checks on the drift-corrected clock | 3, 69 |
| HZ-011 | Agency access from booked shifts; rota-derived team scope; casework and whistleblowing silos | 24, 27, 39 |
| HZ-013 | Safeguarding, outbreak and medication-error clocks in the notification centre | 13, 31, 45 |
| HZ-021 | The downtime pack lists doses due, time-critical first (H-102) | 49 |
| HZ-023 | Transfer pack medicines from the eMAR; reconciliation on return (H-82) | 49 |
| HZ-026 | Covert administration only under a current best-interests record per medicine | 38 |
| HZ-071 | An export round-trips through the import wizard with matching counts | 26 |
| HZ-073 | Safeguarding concerns and silo cases still reach the people who must act | 13, 24 |
| HZ-112 | Single sign-on never stands in for Harbour's second factor on care records | 33 |

**Medical-device boundary.** Every lane A slice, slices 12, 21 and 47, and any slice touching an
alert answers the boundary question in the pull request. Phase 2 stays inside the boundary: no dose
calculation or dose-range advice, no automated allergen matching, no Harbour-made staffing or
quality score (the dependency scale and targets are the tenant's own, labelled so); the barcode
match checks identity, not clinical suitability. Section 6 of
[medical-device-boundary.md](../compliance/medical-device-boundary.md) gains the decisions of
ADR-0082 in slice 3.

### Data protection per slice

Records of processing purposes are those in
[records-of-processing.md](../compliance/records-of-processing.md) (B1 to B10); new purposes take
B13 onwards (B11 and B12 are the transfers and security sections). Lawful bases are proposals until
the DPO confirms them (H-526). No slice adds a sub-processor by default; the conditional ones are
listed for the DPO (H-520).

| Slice | Records of processing | Data standards | DPIA risk | Sub-processors |
| --- | --- | --- | --- | --- |
| 10 | None (national reference data, no personal data) | dm+d identifiers (VTM, VMP, AMP, VMPP, AMPP), units, forms, routes, GTIN | - | None (TRUD is a download source and receives no personal data) |
| 11 | B3: vetting, including criminal offence data (Article 10, DBS) and health declarations | Staff file fields; NMC PIN; DBS certificate details kept only as retention allows (H-525) | R20 | - |
| 12 | B1: dependency category | Dependency fields (tenant scale, not a national code) | - | - |
| 13 | B4: safeguarding log | s.42 and Making Safeguarding Personal fields | - | - |
| 14 | None (organisation data) | CQC statement identifiers | - | - |
| 15 | New B13: data-protection rights handling | Subject map per table | R23 | - |
| 16 | B1: medicines and reconciliation | dm+d codes, dose and unit, route, indication | - | - |
| 17 | B3: training and competence | - | - | - |
| 18 | New B14: complaints (Regulation 16) | - | - | - |
| 19 | B5: audit findings that name people | - | - | - |
| 20 | B13: breaches and data-protection complaints | - | R24 | - |
| 21 | B3: rotas | - | - | - |
| 22 | B1: administrations, scan evidence | MAR outcome and reason codes; GS1 fields | - | - |
| 23 | New B15: applicants | - | R29 | - |
| 24 | New B16: whistleblowing | - | R21 | - |
| 25 | B3: read-and-sign records | - | - | - |
| 26 | B1 to B3 as imported | The import contract | R26 | - |
| 27 | B3: agency workers | - | - | Agencies are the tenant's own counterparties (H-547) |
| 28, 38 | B1: PRN, covert, self-administration (R18 extended for covert administration) | - | R18 | - |
| 29 | B3: induction, Care Certificate and probation records; leavers and references | - | R20 | - |
| 30 | B3: time and attendance, clock-in location | - | R22 | - |
| 31 | B7: outbreak reports | UKHSA report fields | - | - |
| 33 | B5: identity provider links | - | R27 | - |
| 34 | B1: controlled drugs register | - | - | - |
| 35 | New B17: sponsor-licence duties; B3: staff privacy notice and image consent | - | R20 | - |
| 36, 40 | B3: pay calculations, absence, fit notes (health data) | - | R20 | - |
| 37 | B7: deaths and missing persons | Herbert Protocol fields | - | - |
| 39 | B3: casework | - | R21 | - |
| 41 | New B18: disclosure requests | - | R23 | - |
| 42 | B1: stock and disposal records that name people | - | - | - |
| 43 | B3: e-learning attempts and statements | xAPI statement fields | - | - |
| 44 | B3: wellbeing surveys | - | R28 | - |
| 45 | B1 and B7: medication errors | - | - | - |
| 46, 71 | B3: lone-worker check-ins and location | - | R22 | - |
| 51 | B1 and B3 as imported; TUPE transfers between group tenants | The import contract for medicines, care plans and staff files | R26 | - |
| 76 | B3: payroll export | Payroll fields per provider | R25 | Payroll providers (H-520) |
| 77 | B3: vetting results | - | R25 | IDSP and DBS e-bulk providers (H-520, H-521, H-522) |
| 78 | B3: external training records | - | R25 | LMS providers (H-520) |
| 79 | B1: scanned MARs | - | R25 | DocuSign only if a tenant switches it on (H-540) |

Other slices add no new personal data beyond the rows above. The mobile slices (68 to 73) hold B1
and B3 data on devices under the existing measures for R2 and R8 (encryption, auto-lock, remote
wipe, shared-device sign-in); slices 32 and 47 hold organisation data and counts, never names.

DPIA risks R20 to R29 (slice 84 writes them; each slice above records its measures):

| ID | Risk |
| --- | --- |
| R20 | Staff vetting and employment records (DBS and criminal offence data, right to work and immigration, health declarations, fit notes) seen beyond HR or kept too long |
| R21 | The identity of a whistleblower or the subject of a case disclosed, or a silo reached by a wider role |
| R22 | Clock-in location, NFC and lone-worker check-ins used to monitor staff beyond their purpose |
| R23 | A subject access bundle or disclosure that reveals third parties, misses records or goes beyond its legal basis |
| R24 | A breach not assessed or reported within 72 hours, or a tenant not told by Thapsus as processor |
| R25 | Payroll, vetting, learning and e-signature providers receiving staff or care data, possibly outside the UK |
| R26 | Imported data inaccurate, excessive, or about people outside the service |
| R27 | An identity provider account linked to the wrong member, or sign-in without Harbour's second factor |
| R28 | A respondent identified from small-group staff survey results |
| R29 | Applicants' data kept after an unsuccessful application or used beyond recruitment |

Retention classes already exist for MAR charts, the CD register, complaints, serious incidents,
staff files, right-to-work copies, training records, rotas and timesheets, working-time records and
opt-outs, and organisation documents ([retention.md](../specs/retention.md)). The DPO sets the gaps
before the slice that needs them merges, or the slice applies the class of the record it attaches
to (H-525): unsuccessful applicants (23), DBS certificate details (11), DSAR cases, breaches and
data-protection complaints (15, 20), safeguarding (13), whistleblowing (24), casework (39), stock,
disposal and temperature logs (42), the disclosure log (41), audits (19), surveys (44), lone-worker
check-ins (46), sponsor records (35), payroll exports (76) and import batches (26).

## Gate (section 19): verified by Claude Code

| Gate item | Evidence |
| --- | --- |
| A medication round completes offline with barcode and witness in the Maestro suite | `apps/mobile/.maestro/hazard-HZ-003-offline-round.yaml` and a controlled drug flow with a witness (slices 69, 70), passing in `.github/workflows/mobile.yml` on an iOS simulator and an Android emulator (the iOS job is new; Phase 1 runs Android only; H-542); the run id recorded in the gate record |
| Expired competence blocks administration in tests | `packages/domain` (medicines) `hazard HZ-119 expired medicines competence blocks an administration` and `apps/api` `hazard HZ-119 an administration by a member whose competence has expired is refused unless a manager override is recorded` (slices 3, 22); HZ-003's control row marked passing |
| NMW, holiday and SSP rule tables pass | Table-driven tests in `packages/domain/src/scheduling` for NMW per pay reference period, holiday accrual and rolled-up pay, and SSP, reading figures from the seeded rate rows (slice 6, extended in 36); a test that fails if any of those figures appears as a literal in the scheduling source |
| Cyber Essentials technical controls evidenced | `docs/compliance/cyber-essentials.md` with evidence for each of the five control themes (slice 80) |
| ISO 27001 control mapping drafted (section 19 scope) | `docs/compliance/iso27001-controls.md` (slice 80) |
| Every Phase 2 register row `done` (definition of done) | The register: 59 rows linking spec, code, tests and user documentation (slices 81 to 83) |
| Every hazard-log entry has a test | `grep -rn "HZ-1" apps packages` against the log for HZ-113 to HZ-130 and the extended rows |
| WCAG scans clean | Playwright and axe on every new screen (slices 52 to 67), at 360 px (slice 74) |
| Clinical safety case v0.2 drafted | `docs/clinical-safety/safety-case/` (slice 85; signature H-545) |
| Data-protection documents current | Records of processing B13 onwards, data standards, DPIA section 7B with R20 to R29 (slice 84; sign-off H-544) |

## Human follow-ups (logged, never blocking)

Section 19's Phase 2 follow-ups: a pharmacist or nurse reviews the MAR and CD register exports
(H-515); Thapsus books the Cyber Essentials Plus assessment (H-40, with H-536). The full list for
this phase is H-510 to H-549 in [human-actions.md](human-actions.md#phase-2-medicines-and-workforce).
Phase 1 items the eMAR revisits: H-82 (transfer pack medicines), H-102 (downtime pack residual
risk), H-151 (care plan medicines actions and rounds), H-22 (the clock-change rule for doses) and
H-52 (sponsored workers).
