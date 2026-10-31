# Clinical safety case report v0.2: Phase 2 medicines, workforce and safety (first draft)

| Item | Value |
| --- | --- |
| Product | Harbour |
| Manufacturer | Thapsus Cargo Ltd |
| Release | Phase 2, platform version `v0.2.x` `[release tag and commit - filled at tagging]`. Drafted against `main` at `a47f82fb`, with the Phase 2 branches and pull requests named in section 2 |
| Previous report | [v0.1 Phase 1 residential MVP](safety-case-v0.1-phase1.md) (draft, not signed) |
| Report status | **First draft**. Not signed. Clinical Safety Officer approval pending. Not for use with a live tenant |
| Prepared by | Harbour engineering (Claude Code under the lead engineer), 31 October 2026 |
| Clinical Safety Officer | `[CSO name - human action]` (not yet appointed, H-20) |
| Standard | [DCB0129](https://adultsocialcare.standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-manufacture-of-health-it-systems) |
| Clinical risk management file | [Clinical risk management plan](../clinical-risk-management-plan.md), [hazard log](../hazard-log.md), [medical-device boundary](../../compliance/medical-device-boundary.md), [DCB0160 deployment template](../dcb0160-deployment-template.md) |

## Document control

| Version | Date | Status | Change |
| --- | --- | --- | --- |
| 0.2 draft A | 31/10/2026 | Draft | First draft for plan slice 85, covering the Phase 2 hazards added so far (section 2) |

**Distribution**: Thapsus engineering; Brian (top management); the CSO once appointed. Not for
tenants until signed ([README](README.md)).

**Owner and review**: the CSO owns this report once appointed. It is updated as each Phase 2 slice
merges, completed for the Phase 2 gate (`docs/plans/phase-2-gate.md`, slice 85), and reviewed at
tagging.

## 1. Purpose

This report extends [v0.1](safety-case-v0.1-phase1.md) to Phase 2. It is a first draft, written
while Phase 2 is being built: it covers only the Phase 2 hazards added to the hazard log so far, on
`main` or on the branches and pull requests named below, and says for each its rating, its controls,
the tests that verify them, what stays open and the decision the CSO must make.

Everything v0.1 says about Phase 1 stands unless this report changes it: the system definition,
the clinical risk management system, the assumptions, the Phase 1 hazards and their residual risks,
the deployer information and the known limitations. Neither report is signed. Harbour cannot sign
its own safety case: every rating and residual risk below is an engineering proposal until a
Clinical Safety Officer reviews and accepts it (sections 8 and 10).

## 2. What this draft covers

Evidence is cited on the branch where it sits; a test or file is on `main` only once its pull
request merges. This report is updated as they merge.

| Hazard | Plan slice | Where the entry and its evidence are | State |
| --- | --- | --- | --- |
| HZ-113 dm+d reference data out of date, loaded wrongly or missing on a device | 10 (also 68, 75) | No hazard-log entry yet | Slice in progress |
| HZ-116 A two-person check done by one person or not genuinely witnessed | 3 | `feat/meds-domain-administration` | Domain rules built |
| HZ-119 Expired competence does not block administration, or the manager override becomes routine | 3 | `feat/meds-domain-administration` | Domain rules built |
| HZ-121 Medicines not reconciled after admission, transfer or return from hospital | 2 | #135 (`feat/meds-domain-record`; also on `feat/meds-domain-administration`) | Domain rules built |
| HZ-123 Staffing below the tenant's assessed need or skill mix without a visible warning | 12 | #153 (`feat/sched-dependency-tool`) | Domain, schema and API built |
| HZ-124 A worker without a required check, training or competence rostered to a shift that needs it | 4 | `main` | Domain rules built |
| HZ-126 A safeguarding concern not progressed, or protective measures not visible to the staff caring for the person | 13 | #155 (`feat/safety-safeguarding-log`) | Schema and API built |
| HZ-127 A missing person's escalation delayed, or the Herbert Protocol profile out of date | 37 | No hazard-log entry yet | Slice in progress (rules from slice 7 on `main`) |
| HZ-128 Staff follow a superseded policy or procedure | 25 (rules in 8) | #154 (`feat/quality-policy-library`) | Schema and API built |
| HZ-130 Imported records mis-mapped, duplicated or attached to the wrong person | 26 | #150 (`feat/platform-import-wizard`) | Schema and API built (people) |

No Phase 2 slice has web or mobile screens yet. Every hazard below is therefore controlled, so far,
in the domain rules, the database and the API; screens, print and the mobile app are later slices,
and their tests are listed as planned (section 7).

## 3. Clinical safety claim (provisional)

When Phase 2 is complete and deployed as described, with the deployer controls in v0.1 section 14
and in section 9 below, it will be acceptably safe for its intended use. **This claim cannot yet be
made**: the slices are not all built, no Phase 2 screen exists, two hazards (HZ-113, HZ-127) have no
entry yet, two (HZ-124, HZ-128) have no rating yet, and the CSO has reviewed none of them. The
argument below is the evidence so far.

## 4. Hazards: ratings at a glance

The risk matrix is in the [clinical risk management plan](../clinical-risk-management-plan.md).
Ratings are severity, likelihood and risk level, as the hazard log gives them. Some of the human actions named below (H-595, H-599, H-680, H-682, H-710, H-712, H-740, H-744) are logged on the hazard's own branch and reach [human-actions.md](../../plans/human-actions.md) on `main` when its pull request merges.

| Hazard | Initial | Proposed residual | Hazard-log CSO action |
| --- | --- | --- | --- |
| HZ-113 | Not rated (no entry) | Not rated | Entry needed with slice 10 |
| HZ-116 | Major / Medium / 3 | Major / Low / 3 | H-513 |
| HZ-119 | Major / Medium / 3 | Major / Low / 3 until the override report (slice 45), then Very low / 2 | H-513 |
| HZ-121 | Major / Medium / 3 | Major / Low / 3 | H-513 |
| HZ-123 | Major / Medium / 3 | Major / Low / 3 until the rota shows the comparison (slices 21, 59), then Very low / 2 | H-710, H-543 |
| HZ-124 | `[CSO rating - human action]` | `[CSO rating - human action]` | H-543 |
| HZ-126 | Major / Medium / 3 | Major / Low / 3 until H-599 is settled, then Very low / 2 | H-595, H-599 |
| HZ-127 | Not rated (no entry) | Not rated | Entry needed with slice 37 |
| HZ-128 | `[CSO rating - human action]` | `[CSO rating - human action]` | H-543, H-740 |
| HZ-130 | Major / Medium / 3 | Major / Low / 3 | H-543, H-680 |

Six hazards are proposed at a residual level of 3 (HZ-116, HZ-119, HZ-121, HZ-123, HZ-126, HZ-130).
The plan allows level 3 only where further reduction is impractical; each entry gives its
justification, and the CSO accepts or rejects each (section 10).

## 5. Hazard by hazard

### HZ-113 dm+d reference data out of date, loaded wrongly or missing on a device

- **Rating**: none yet. The plan names the hazard for slice 10 (the dm+d reference data), with
  slices 68 (the phone) and 75 (the monthly release download, with a failure alert).
- **Controls and evidence**: none in the hazard log yet.
- **Open**: the hazard-log entry, with its controls and `hazard HZ-113` tests, is written with slice
  10 before it merges.
- **CSO decision**: rate it when the entry exists (H-842).

### HZ-116 A two-person check done by one person or not genuinely witnessed

- **Rating**: Major / Medium / 3, proposed residual Major / Low / 3.
- **Controls built** (domain, slices 2 and 3): the second check of a MAR entry or a dosing record is
  refused from the person who wrote it, from someone without current medicines competence, and
  without the checker confirming they compared it with the source; every controlled drugs entry
  has a witness who is not the recorder, always where the tenant's policy is `required` (by default
  residential, nursing, respite and children's homes) and, where it is `where_available`, a lone
  worker's reason for no witness flagged for manager review; destruction always witnessed; a
  competence override never approved by the member themselves.
- **Evidence**: `packages/domain/src/medicines/mar-entry.test.ts` (`hazard HZ-005 the checker must be a
  different user from the transcriber`); `dosing-record.test.ts` (`hazard HZ-116 a dosing record is
  checked by a second, competent person who compared it with its source`);
  `controlled-drugs.test.ts` (`hazard HZ-116 a controlled drugs entry is witnessed by a second person,
  as the tenant's policy says`); `competence.test.ts` (`refuses an override approved by the member
  themselves`). All passing on `feat/meds-domain-administration`.
- **Open**: the witness signing in with their own factor on the same device, re-verified by the
  server (slices 34 and 70; ADR-0084), and its API test; the deployer's witness policy (slice 81).
- **Justification for level 3**: Harbour can make two different, competent, signed-in people put
  their names to a check, but cannot see whether the second person genuinely watched or compared.
- **CSO decision**: accept or reject level 3 (H-513, H-841).

### HZ-119 Expired competence does not block administration, or the manager override becomes routine

- **Rating**: Major / Medium / 3, proposed residual Major / Low / 3 until the override report
  exists (slice 45), then Very low / 2.
- **Controls built** (domain, slice 3): competence current until 00:00 UK time on the date
  `competence.medicines.refresh_months` after the last observed sign-off (the last day of a
  shorter month, never later); every outcome a member records, not only "given", needs current
  competence or an override in force recorded by someone else with a reason, for at most
  `medicines.competence_override.max_hours`; every overridden record flagged for the override
  report.
- **Evidence**: `packages/domain/src/medicines/administration.test.ts` (`hazard HZ-119 expired medicines
  competence blocks an administration`); `competence.test.ts` (`hazard HZ-119 medicines competence
  lasts the rate table's months from its sign-off` and `hazard HZ-119 expired medicines competence
  blocks an administration unless someone else overrides it`). Passing on
  `feat/meds-domain-administration`.
- **Open**: the API reading competence on the server from workforce's port, never from the request
  (ADR-0085, slices 17 and 22) and its test; competence on the device for offline use (slice 68);
  the override report and its trend (slice 45).
- **Justification for level 3 for now**: the gate is in the rule every record passes through, but an
  override that becomes routine is visible only record by record until the report exists.
- **CSO decision**: accept or reject level 3 until slice 45 (H-513, H-841).

### HZ-121 Medicines not reconciled after admission, transfer or return from hospital

- **Rating**: Major / Medium / 3, proposed residual Major / Low / 3.
- **Controls built** (domain, slice 2, with three review rounds on #135): every MAR entry in force
  needs one decision a person made (continue, change, stop or query), and Harbour never infers a stop
  because a source leaves a medicine out; a decision is supported only by a line that says that thing
  about the same dm+d product; a stop cites a current line that says so; a continue needs a line that
  shows what is prescribed now (on a return, the discharge letter's line); one entry per dm+d VMP,
  by identity only, never by ingredient; every line in every source needs a decision; completion
  refused while a query is open, a decision is missing, a new entry fails the transcription rules, the
  completer's competence is not current, or the allergies in the sources have not been compared with
  the record by the completer (no automated matching); new and changed medicines arrive "Not yet
  checked" for a second person (HZ-005); every admission, transfer and return without a completed
  reconciliation listed on the person's medicines record.
- **Evidence**: `packages/domain/src/medicines/reconciliation.test.ts` (the `hazard HZ-121` cases for
  every rule above, including the discharge letter on a return, the query block, the competent
  completer and the allergy comparison). Passing on #135.
- **Open**: the API applying a reconciliation and completing the people lifecycle's return check in
  one transaction (slice 16); the nurse's journey with Playwright and axe (slice 52); the transfer
  and downtime packs listing medicines from the eMAR (slice 49).
- **Justification for level 3**: Harbour can make every medicine and every source line need a
  person's decision, but cannot know whether the discharge letter is right or read correctly.
- **Boundary**: the product comparison is by dm+d identity only, never by ingredient, and the
  allergy comparison is the completer's, not Harbour's (section 6).
- **CSO decision**: accept or reject level 3 (H-513, H-841).

### HZ-123 Staffing below the tenant's assessed need or skill mix without a visible warning

- **Rating**: Major / Medium / 3, proposed residual Major / Low / 3 until the rota shows the
  comparison (slices 21, 59), then Very low / 2.
- **Controls built** (domain, schema and API, slice 12, #153 review round 1): no scale in force
  gives no figure and a warning, never 0; people not counted are named and the figure becomes "at
  least" N hours; who is at the home is worked out for the date asked (a planned admission counts
  from its date; someone away today is "not known" on a later date); a comparison carries every
  warning and says "met" only when complete and nothing falls short; every status has a word; a
  scale version is approved only by someone who neither wrote nor changed it and is fixed once
  approved; periods are UK wall-clock windows tested across both clock changes; the API refuses a
  request whose scope does not cover the whole home; every figure is labelled as the organisation's
  own tool.
- **Evidence**: `packages/domain/src/scheduling/dependency.test.ts`, `packages/db/test/dependency.test.ts`
  and `apps/api/test/dependency.test.ts` (the `hazard HZ-123` cases). Passing on #153.
- **Open**: the comparison beside each shift on the rota before publishing, with Playwright and axe
  (slices 21 and 59); the manager guide (slice 82); the organisation writing and approving its own
  scale (H-712).
- **Justification for level 3 for now**: the requirement and comparison are computed, but no rota
  screen shows them yet.
- **Boundary**: the figures are the organisation's own method, with no score, risk level or
  judgement of safe staffing (section 6).
- **CSO decision**: accept or reject level 3 until the rota shows the comparison (H-710, H-841).

### HZ-124 A worker without a required check, training or competence rostered to a shift that needs it

- **Rating**: not yet rated; the CSO rates it at the Phase 2 workshop (H-543).
- **Controls built** (domain, slice 4, on `main`): one rule (`rosterDecision`) decides whether a
  worker can be rostered on the shift's UK date: DBS clear (or supervised-only clearance on a
  supervised shift), a right to work, a current registration where the role needs one, and every
  competence the shift needs; each blocker listed in words; a manager override needs a typed
  justification, lists what it overrides and never covers a missing right to work.
- **Evidence**: `packages/domain/src/workforce/rostering.test.ts` (the `hazard HZ-124` cases), and
  `competence.test.ts`, `dbs.test.ts`, `right-to-work.test.ts` and `registration.test.ts` for the
  inputs. Passing on `main`.
- **Open**: the rota applying the rule when a shift is planned and again on the day, showing the
  blockers, and logging and reporting overrides (slices 21, 27 and 59), with their tests.
- **CSO decision**: rate it, initial and residual (H-543, H-841).

### HZ-126 A safeguarding concern not progressed, or protective measures not visible to the staff caring for the person

- **Rating**: Major / Medium / 3, proposed residual Major / Low / 3 until the questions in H-599 are
  settled, then Very low / 2. Whether Catastrophic applies (organisational abuse, or a person who
  harms and moves on, can harm several people) is for the CSO (H-595).
- **Controls built** (schema and API, slice 13, #155 review round 1): a referral target from the rate
  table that stays overdue until the concern is referred or a reason not to refer is recorded; an
  urgent alert to the safeguarding managers at the person's current home, repeated daily so
  acknowledging it never silences it; a concern never dropped silently (a reason and who decided for
  not referring, the raiser cannot decide it alone or close it, the other managers told, Making
  Safeguarding Personal before the referral decision, the staff question with no default and the
  DBS decision where a member of staff was removed or would have been, only ended concerns
  soft-deleted), checked in the API and the database; staff caring for the person read the
  protective measures of open concerns, never the allegation, and the measures are carried into the
  care plan or ended before a concern closes.
- **Evidence**: `packages/domain/src/safety/safeguarding.test.ts`, `packages/db/test/safeguarding-log.test.ts`
  and `apps/api/test/safeguarding.test.ts` (the `hazard HZ-126` cases, including both clock changes,
  the daily re-alert after a manual acknowledgement, and the raiser refused). Passing on #155.
- **Open**: the web screens and the measures on the record header (slice 62); protective measures on
  the phone at the point of care, a second person for a decision not to refer, and "DBS referral not
  required" when the s.35 conditions are met (H-599); the unrouted audit has no fixture yet.
- **CSO decision**: rate it and decide the H-599 questions (H-595, H-599, H-841).

### HZ-127 A missing person's escalation delayed, or the Herbert Protocol profile out of date

- **Rating**: none yet. The plan names the hazard for slice 37, with the screens in slice 63. The
  rules (`packages/domain/src/safety/missing-person.ts`: the timeline, the police call target, the
  Herbert Protocol review date, the welfare check and debrief) are on `main` from slice 7 under HZ-013.
- **Controls and evidence**: none under HZ-127 yet.
- **Open**: the hazard-log entry, with its controls and `hazard HZ-127` tests, written with slice 37;
  the police call target with the local police (H-591).
- **CSO decision**: rate it when the entry exists (H-842).

### HZ-128 Staff follow a superseded policy or procedure

- **Rating**: not yet rated; the CSO rates it at the Phase 2 workshop (H-543).
- **Controls built** (rules in slice 8, schema and API in slice 25, #154): at most one published
  version per policy, enforced by the database, and publishing supersedes the one before in the same
  transaction; a superseded or retired version always served with its state and the version in force
  now (on its PDF too); the list shows only the version in force; the general document routes serve a
  policy's PDF only while it is in force; read-and-sign by role, a major change asking everyone again;
  reminders through the task engine, completed only by signing.
- **Evidence**: `packages/domain/src/quality/policies.test.ts`, `packages/db/test/policies.test.ts` and
  `apps/api/test/policies.test.ts` (the `hazard HZ-128` cases). Passing on #154.
- **Open**: the screens and print showing state and version on every page (slice 65); a validated
  tool's link to the escalation policy points at a document, not the library (named as a cause in
  the entry); the CSO decisions from the slice 25 review (H-744).
- **CSO decision**: rate it (H-543, H-740, H-744, H-841).

### HZ-130 Imported records mis-mapped, duplicated or attached to the wrong person

- **Rating**: Major / Medium / 3, proposed residual Major / Low / 3.
- **Controls built** (schema and API, slice 26, #150, people first): columns matched only by the
  mapping or a field's own key or label, and anything unmatched refuses the upload; every value
  checked against the data standards (dd/mm/yyyy dates, dates of birth from 1900, the NHS number
  check); duplicates within the file and against existing people reported, and an import never
  merges with or attaches to an existing person; a dry run before any commit; imported people carry
  their batch and undo removes exactly them, once, within the window, and is refused once a phone may
  hold them (the batch then shows no undo, and where phones are in use the importer accepts before
  committing that it cannot be relied on to be undone); possible duplicates bounded so each can be
  read; only an organisation-wide importer who can read people, so matching never discloses a person
  they cannot see; allergy statuses imported as not recorded, with a task carrying what the file
  said for each person whose status it stated.
- **Evidence**: `packages/domain/src/platform/imports.test.ts`, `packages/db/test/imports.test.ts` and
  `apps/api/test/imports.test.ts` (the `hazard HZ-130` cases). Passing on #150.
- **Open**: the wizard showing the mapping beside the file's first rows (slice 67); contacts,
  allergies and staff matched by identifier only (later part of slice 26; slice 51); imported
  medicines "not yet checked" (slice 51); a "created in error" status for a person imported by
  mistake once undo is gone (a follow-up; the CSO decides, H-680); the tenant's checks of the source
  export and of a sample before and after committing (H-682).
- **Justification for level 3**: a file whose dates are consistently month-first with every day 12
  or under, or whose names are consistently swapped, passes every automated check.
- **CSO decision**: accept or reject level 3, and the clinical decisions in ADR-0092 (H-680, H-841).

## 6. Medical-device boundary

No hazard here crosses the boundary in [medical-device-boundary.md](../../compliance/medical-device-boundary.md).
The points to check are:

- **HZ-121**: products are compared by dm+d identity only, never by ingredient, and the allergy
  comparison is the completer's; Harbour suggests no medicine and calculates no dose.
- **HZ-123**: the dependency figures are the organisation's own tool (section 6 of the boundary
  document lists it as a grey area), labelled as such, with no score, risk level or judgement of
  safe staffing.
- **HZ-126**: the safeguarding log stores records and runs a target clock; it decides nothing about
  whether abuse happened.

The CSO confirms the HZ-121 and HZ-123 positions (H-842).

## 7. Verification status

Passing on the branch or pull request named in section 2: the `hazard HZ-116`, `HZ-119`, `HZ-121`,
`HZ-123`, `HZ-124`, `HZ-126`, `HZ-128` and `HZ-130` tests listed in section 5. They run in CI on
their pull requests; a CI run link is recorded here once each merges.

Planned, not yet written:

| Hazard | Test | Slice |
| --- | --- | --- |
| HZ-113 | Every control | 10, 68, 75 |
| HZ-116 | The witness signs in with their own factor on the same device, re-verified by the server | 34, 70 |
| HZ-119 | An administration by a member with expired competence refused through the API unless overridden | 22 |
| HZ-121 | A reconciliation applied in one transaction, completing the return check; the nurse's journey with axe | 16, 52 |
| HZ-123 | The rota comparison before publishing, with Playwright and axe | 21, 59 |
| HZ-124 | The rota applying the rule when planned and on the day | 21, 27, 59 |
| HZ-126 | The screens and the measures on the record header; the unrouted audit with a fixture | 62 |
| HZ-127 | Every control | 37, 63 |
| HZ-128 | Screens and print with state and version on every page | 65 |
| HZ-130 | The wizard's mapping preview; contacts and allergies attached by identifier only | 67, 26 |

## 8. Residual risk

Level-3 proposals (section 4) and their justifications are in each hazard's entry and section 5.
None is accepted; the CSO decides each (section 10). HZ-124 and HZ-128 have no rating, and HZ-113 and
HZ-127 no entry, so the residual risk of Phase 2 as a whole cannot yet be stated.

## 9. Deployer information added by Phase 2 so far

For the tenant's [DCB0160 assessment](../dcb0160-deployment-template.md), from the entries above:

- The witness policy per service, and what "witnessed" means (HZ-116).
- The competence assessment programme and who may approve overrides (HZ-119).
- The reconciliation policy: who completes it and how soon after an admission or return (HZ-121).
- The organisation's own dependency scale, its review, and what to do about a shortfall (HZ-123,
  H-712).
- The organisation's safeguarding policy and the local authority's procedures (HZ-126).
- Policies opened in Harbour, not from printed copies (HZ-128).
- Checking the source export and a sample before committing, and a sample after (HZ-130, H-682).

## 10. Decisions for the CSO

| Decision | Human action |
| --- | --- |
| Rate HZ-124 and HZ-128 | H-543 |
| Accept or reject the level-3 residual risks for HZ-116, HZ-119, HZ-121, HZ-123, HZ-126 and HZ-130 | H-841 (with H-513, H-710, H-595, H-680) |
| Whether Catastrophic severity applies to HZ-126, and the three H-599 questions | H-595, H-599 |
| Confirm the boundary positions for HZ-121 and HZ-123; rate HZ-113 and HZ-127 when their entries exist | H-842 |
| Review and sign v0.2 at the Phase 2 gate | H-840 |

## 11. Sign-off

**Clinical Safety Officer approval: pending.** Harbour engineering cannot sign this report. The CSO's
review and signature, and top management's acknowledgement, are logged as H-840 in
[docs/plans/human-actions.md](../../plans/human-actions.md).

| Role | Name | Registration | Date | Signature |
| --- | --- | --- | --- | --- |
| Clinical Safety Officer | `[CSO name - human action]` | `[professional body and number - human action]` | `[date]` | `[signature - human action]` |
| Top management | `[Brian, Thapsus director - human action]` | Not applicable | `[date]` | `[signature - human action]` |

| Level-3 residual risk | Proposal | CSO decision |
| --- | --- | --- |
| HZ-116 | Level 3 | `[accept or reject - human action]` |
| HZ-119 | Level 3 until slice 45, then 2 | `[accept or reject - human action]` |
| HZ-121 | Level 3 | `[accept or reject - human action]` |
| HZ-123 | Level 3 until slices 21 and 59, then 2 | `[accept or reject - human action]` |
| HZ-126 | Level 3 until H-599, then 2 | `[accept or reject - human action]` |
| HZ-130 | Level 3 | `[accept or reject - human action]` |
