# Clinical safety case report v0.1: Phase 1 residential MVP

| Item | Value |
| --- | --- |
| Product | Harbour |
| Manufacturer | Thapsus Cargo Ltd |
| Release | Phase 1 residential MVP, platform version `v0.1.x` `[release tag and commit - filled at tagging]`. Drafted against `main` at `aae5ab5` |
| Previous report | [v0.0 Phase 0 foundations](safety-case-v0.0-phase0.md) (draft, not signed) |
| Report status | **Draft**. Not signed. Clinical Safety Officer approval pending. Not for use with a live tenant |
| Prepared by | Harbour engineering (Claude Code under the lead engineer), 31 October 2026 |
| Clinical Safety Officer | `[CSO name - human action]` (not yet appointed, H-20) |
| Standard | [DCB0129](https://adultsocialcare.standards.nhs.uk/published-standards/clinical-risk-management-its-application-in-the-manufacture-of-health-it-systems) |
| Clinical risk management file | [Clinical risk management plan](../clinical-risk-management-plan.md), [hazard log](../hazard-log.md), [medical-device boundary](../../compliance/medical-device-boundary.md), [DCB0160 deployment template](../dcb0160-deployment-template.md) |

## 1. Purpose

This report summarises the clinical safety case for the Phase 1 residential MVP: the first Harbour
release with clinical functions that care workers, nurses and managers use to record and act on care.
It sets out what the release does, the safety claim made for it, the argument and the evidence for
that claim, the hazards and their ratings, what has not yet been verified, and what a deploying
provider must put in place.

It builds on [v0.0](safety-case-v0.0-phase0.md). Neither report is signed. Harbour cannot sign its
own safety case: the ratings and residual risks below are engineering proposals until a Clinical
Safety Officer reviews and accepts them (section 13).

## 2. System description and intended use

### 2.1 Intended purpose

The intended purpose statement from the [medical-device boundary](../../compliance/medical-device-boundary.md),
section 2, used unchanged:

> Harbour is a digital social care record and operational platform for regulated adult social care
> providers. It stores, displays and transmits care information, applies rules that the provider
> configures, and calculates published validated assessment tools exactly as published, showing the
> calculation. It does not diagnose, predict, score risk with its own algorithms, or recommend
> treatment or medication. Clinical judgement and escalation remain with the provider's staff and
> follow the provider's own policies.

Intended users in this release: care workers, senior carers, nurses, Registered Managers, quality
and data protection leads at a residential or nursing home (ADR-0004, residential first), and family
members reading the feed. The intended setting is a care home in England.

### 2.2 What the Phase 1 release contains

Scope is the Phase 1 rows of the [feature register](../../specs/feature-register.md) and
[phase-1.md](../../plans/phase-1.md). None of the 54 rows is `done` under the definition of done
(section 19), mainly because user guides are missing ([phase-1-gate.md](../../plans/phase-1-gate.md),
section 6); the table says what is built.

| Area | Built in this release | Main hazards |
| --- | --- | --- |
| People lifecycle (residential) | Person record, communication needs, About Me, pre-admission, admission with rooms and property, review scheduling, hospital transfer pack, discharge, transfer and death with a read-only archive, sharing rules (API; some web screens) | HZ-001, HZ-007, HZ-015, HZ-016, HZ-022, HZ-023 |
| Care record | Care plans and versions, risk assessments, daily notes, five charts (fluids, food with IDDSI, repositioning, bowel, weight) and vital signs, body map, activities and visits, advance care records, history views | HZ-012, HZ-014 to HZ-017, HZ-019, HZ-024, HZ-025, HZ-028 |
| Validated tools | NEWS2, MUST, Waterlow, Braden and the NICE NG249 falls pathway (no score), calculated on the server, with the tenant's escalation policy linked | HZ-012, HZ-014 |
| Tasks, rounds and handover | Care plan actions generate shift tasks; round view; overdue escalation; handover compiled from the shift's records with acknowledgement | HZ-003, HZ-008, HZ-018, HZ-024 |
| Consent, capacity and DoLS | Consent records, two-stage capacity assessment, best-interests checklist, DoLS register with expiry clocks and the 2026 legal-change review | HZ-020, HZ-026 |
| Incidents and notifications | Incident capture, classifier (CQC regulations 16 and 18, RIDDOR, safeguarding, candour, LeDeR and others), deadline clocks, statutory notification drafts with step-up submission, post-fall checklist, candour, investigations (API) | HZ-013, HZ-027, HZ-090, HZ-091 |
| Continuity | Nightly downtime pack per location, outages and back-entry of paper records with reconciliation | HZ-017, HZ-021, HZ-092 |
| Disclosure | Inspector evidence pack (watermarked PDF, time-limited link), letters and templates, family feed under a recorded sharing decision, full tenant export, search and break-glass search | HZ-011, HZ-022, HZ-050, HZ-051, HZ-060, HZ-061, HZ-070, HZ-071, HZ-073 |
| Platform | Task and workflow engine, document store, retention and legal hold, onboarding checklist, sample data mode, sessions and MFA for care records, DPIA sign-off | HZ-006, HZ-072, HZ-110 to HZ-112 |
| Offline Care mode (mobile) | Built in part (notes, charts, round actions, device holds, sync streams scoped to assignments) but **paused by the owner** on 16 October 2026; see 2.3 | HZ-001, HZ-002, HZ-006, HZ-029, HZ-040 |

### 2.3 Out of scope for this report

- **Medicines and eMAR** (Phase 2). No medicines administration, MAR, controlled drugs or pharmacy
  interface is built. HZ-003, HZ-004 and HZ-005 are carried with the Phase 1 controls that touch them
  (task escalation, append-only entries, downtime pack wording) and their medicines controls planned.
  Until Phase 2, the provider's paper MAR stays the medicines record (deployer control, HZ-021).
- **The mobile app as a point-of-care tool.** Mobile work is paused by the owner. The offline Care
  mode code and its unit tests exist and are cited where they verify a control, but the Maestro
  offline journey has not run in CI against a syncing build, there is no iOS simulator job, the
  conflict review has not been demonstrated on a device, kiosk mode and device-mode recording are
  not finished, and store readiness (MOB-011, MOB-012) is not started. This report makes **no claim
  that the mobile app is safe to use for care**. Until a later report covers it, deployers use the
  web app only.
- Home care, supported living, the family app mode, nation packs and every Phase 2 to 7 module.
- The optional AI module: not built and off by default.
- The deploying provider's devices, networks, training and local practice (the tenant's DCB0160
  work; [DCB0160 deployment template](../dcb0160-deployment-template.md)).

### 2.4 Deployment status

The release runs in `dev` and `staging` with the demo tenant and invented people only. It is not
deployed for any real person. The design-partner day on two phones and a tablet (H-56) has not
happened.

## 3. Clinical risk management system

The process is the [clinical risk management plan](../clinical-risk-management-plan.md) (draft v0.1,
not yet approved). In summary:

| Element | State at this report |
| --- | --- |
| Risk matrix and acceptability | DCB0129's five-by-five matrix unchanged (plan, sections 3.2 and 3.3). Level 4 or 5 residual risk blocks a production release; level 3 needs the CSO's recorded acceptance |
| Hazard log | [hazard-log.md](../hazard-log.md), in Git beside the code; 45 hazards, IDs never reused |
| Hazard identification | So far from the master specification, the regulator and clinical guidance named in each spec, failure analysis of sync, clocks, tenancy and authentication, and pull request reviews. **No CSO-led SWIFT workshop has been held** (H-23) |
| Pull request controls | The PR template asks every PR for its clinical-safety impact and the medical-device boundary question (`.github/pull_request_template.md`); CODEOWNERS makes `docs/clinical-safety/` a required-review path (`.github/CODEOWNERS`); the CI docs gate fails a `clinical` PR that leaves the hazard log and the safety case untouched (`scripts/check-docs-gate.mjs`, run in `.github/workflows/ci.yml`); the `clinical-safety-reviewer` agent (`.claude/agents/clinical-safety-reviewer.md`) reviews clinical PRs and supports, never replaces, the CSO |
| Traceability | Every test that verifies a control names its hazard ID, so `grep -rn "HZ-0" apps packages` finds the evidence; each hazard's Verification table lists the tests and their status |
| Roles | Top management: Brian (Thapsus). CSO: **not appointed** (H-20). Until then no hazard can be set `controlled`, and every rating is an engineering proposal |
| Post-deployment monitoring | Planned (plan, section 8); nothing to monitor until a live tenant |

## 4. Clinical safety claim

> When deployed and used as described in this report, on the web app, with the deployer controls in
> section 11 in place, the Phase 1 residential MVP is acceptably safe for its intended use, subject
> to the CSO's review of the ratings, the acceptance of the level-3 residual risks in section 9, and
> the closing of the items in section 10 that block go-live.

The claim is **not yet supported** for a live tenant: no CSO has reviewed the evidence, HZ-071's
residual risk is recorded at level 4 until the CSO accepts its controls, and the open items in
section 10 include go-live blockers. The claim holds today only for `dev` and `staging` with demo
data.

## 5. Safety argument and evidence

Claims (C), the arguments (A) that support them, and the evidence (E). Every file path below was
checked to exist on `main` at `aae5ab5`.

### C1. Clinical risk management is established and applied to Phase 1

- **A1.1** The process is documented and the file is complete for this stage. **E**: the
  [plan](../clinical-risk-management-plan.md), [hazard log](../hazard-log.md), this report and
  [v0.0](safety-case-v0.0-phase0.md), the [DCB0160 template](../dcb0160-deployment-template.md).
- **A1.2** Clinical changes cannot merge without touching the safety documents. **E**:
  `scripts/check-docs-gate.mjs` (CI job "Lint, types, API contract, builds and security" in
  `.github/workflows/ci.yml`); `.github/CODEOWNERS`; `.github/pull_request_template.md`.
- **A1.3 (weakness)** The process has not yet had its clinical owner: the plan is unapproved, the CSO
  is not appointed and no SWIFT workshop has been held (H-20, H-21, H-23).

### C2. The Phase 1 hazards are identified and assessed

- **A2.1** The 13 day-one hazards from v0.0 were extended with 32 Phase 1 hazards as each slice
  started, using the `hazard` skill (`.claude/skills/hazard/SKILL.md`), each with causes, effects,
  initial rating, controls by type, target residual rating and verification. **E**: hazard log
  HZ-001 to HZ-029, HZ-040, HZ-050, HZ-051, HZ-060, HZ-061, HZ-070 to HZ-073, HZ-080, HZ-090 to
  HZ-092, HZ-110 to HZ-112.
- **A2.2** The expected Phase 1 hazards in [phase-1.md](../../plans/phase-1.md) are all logged: late
  entries (HZ-017), NEWS2 or MUST trigger not reaching the nurse (HZ-014), DoLS expiry (HZ-020),
  handover omissions (HZ-018), body-map laterality (HZ-019), IDDSI (HZ-016), family feed without a
  sharing decision (HZ-022), downtime pack out of date (HZ-021).
- **A2.3** Every rating follows the plan's matrix; severity, likelihood and risk level agree in every
  entry (checked for this report).
- **A2.4 (weakness)** Three candidate hazards wait for the CSO workshop (log, "Candidate hazards for
  the first CSO workshop").

### C3. Controls are implemented and verified by automated tests that run in CI

- **A3.1** Every hazard has at least one automated test that names it. **E**: the Phase 1 gate count
  of 45 of 45 ([phase-1-gate.md](../../plans/phase-1-gate.md), section 4), rechecked for this report
  (every hazard ID appears in at least one test file under `apps` or `packages`).
- **A3.2** Of 592 verification rows in the log, 508 read "Passing"; the rest are listed in section 8.
- **A3.3** The tests run on every pull request and on `main`: package, domain and database tests
  (with RLS isolation) in the "Unit, domain and RLS isolation tests" job, which also holds domain
  rules at 90% line coverage; web journeys with axe in the "Web journeys and accessibility" job
  (`.github/workflows/ci.yml`). **E**: CI run 38932679711 on `5b3d238` was green in every job (gate
  report); the run for the tagged commit is `[CI run link - filled at tagging]`.

### C4. Harbour stays inside the medical-device boundary; validated tools are calculated exactly as published

- **A4.1** The boundary is written down and every clinical PR answers the boundary question. **E**:
  [medical-device-boundary.md](../../compliance/medical-device-boundary.md), sections 2 to 7.
- **A4.2** NEWS2, MUST, Waterlow and Braden are versioned tables with their source cited, tested
  table by table against the published charts, card and form (band boundaries, and the BAPEN worked
  examples for MUST); incomplete or impossible input
  gives no total; the result stores tool version and workings; the client sends answers, never a
  score. **E** (HZ-012): `packages/domain/src/care/news2.test.ts` (including
  `NEWS2_REFERENCE_VECTORS` in `news2-vectors.ts`, points per parameter worked by hand from RCP
  chart 1), `must.test.ts`, `waterlow.test.ts`, `braden.test.ts`, `validated-assessment.test.ts`
  (all in `packages/domain/src/care/`); `apps/api/test/care-planning.test.ts`;
  `apps/web/src/lib/assessments.test.ts`; `apps/web/e2e/care-record.spec.ts`.
- **A4.3** The NG249 falls pathway returns follow-up tasks and no score. **E**:
  `packages/domain/src/care/falls.test.ts` ("returns no numeric risk score, band or risk level").
- **A4.4** Each result links the tenant's own escalation policy, or says plainly that none is
  configured; Harbour writes none of the policy. **E**:
  `packages/domain/src/care/escalation-policy.test.ts`;
  `apps/web/src/components/care/ObservationList.test.ts`.
- **A4.5** Waterlow and Braden are off for every tenant until their licence terms are confirmed.
  **E**: `TOOLS_AWAITING_LICENCE_CONFIRMATION` asserted in `packages/domain/src/care/braden.test.ts`;
  `apps/api/test/care-planning.test.ts` (refused where the flag is off).
- **A4.6** The incident classifier, capacity rules, post-fall checklist, downtime pack, evidence
  pack, letters and family feed add no score or interpretation (boundary document, section 5).
- **A4.7 (weakness)** The regulatory opinion on the tools and the licence terms (H-25), the CSO's
  check of each tool against its source (boundary rule 7; H-129 for the NEWS2 vectors) and ADR-0032
  on risk assessment rating (H-60) are open. Two planned HZ-012 tests (locked templates; the full
  banding table on screen) are not written.

### C5. The right person is identified and their essential information is shown

- **A5.1** The point-of-care header (photo, names, date of birth, room, allergies, communication
  needs, resuscitation status, IDDSI levels; "not recorded" never blank) heads every tab of the web
  record, every round stop and every handover person. **E** (HZ-001, HZ-007, HZ-015, HZ-016):
  `apps/web/src/lib/care-record.test.ts`, `apps/web/src/components/people/PersonHeaderCompact.test.tsx`,
  `apps/web/e2e/care-record.spec.ts`, `apps/api/test/rounds-and-handover.test.ts`,
  `packages/ui-native/src/logic/person.test.ts`.
- **A5.2** Search never matches an NHS number approximately and flags same-name people. **E**:
  `packages/domain/src/platform/search.test.ts`, `apps/web/e2e/search.spec.ts`.
- **A5.3** Occupancy never puts two people in one bed; exits recorded against the wrong person are
  corrected with a reason. **E**: `packages/domain/src/people/occupancy.test.ts`,
  `packages/domain/src/people/lifecycle.test.ts`, `apps/api/test/people-lifecycle.test.ts`.
- **A5.4** The transfer pack and downtime pack carry allergies, resuscitation decisions, IDDSI levels
  and communication needs, and print every conflicting resuscitation record rather than choosing.
  **E** (HZ-015, HZ-016, HZ-023): `packages/domain/src/people/transfer-pack.test.ts`,
  `packages/domain/src/operations/downtime-pack.test.ts`, `apps/api/test/pdf.test.ts`,
  `apps/api/test/downtime.test.ts`.
- **A5.5 (weakness)** Planned and unverified: the similar-name flag, probable-duplicate check, missing
  photo placeholder and no-auto-advance controls (HZ-001); "no known allergies" recorded only
  positively and allergy eviction rules (HZ-007).

### C6. Offline, sync and time controls stop records being lost, duplicated, stale or mis-timed

- **A6.1** Entries are append-only with client UUIDs and idempotent inserts; a retried save records
  once. **E** (HZ-029): `packages/db/test/care-record.test.ts`, `apps/web/src/lib/entry-id.test.ts`,
  `apps/api/test/care-follow-ups.test.ts`.
- **A6.2** Device time and server-received time are both kept; late and back-dated entries are
  marked as such wherever they show. **E** (HZ-010, HZ-017): `packages/domain/src/shared/time.test.ts`,
  `apps/web/src/components/care/EntryBadges.test.ts`, `apps/api/test/device-integrity.test.ts`,
  `apps/api/test/back-entry.test.ts`, `apps/web/e2e/back-entry.spec.ts`.
- **A6.3** UK time is handled once, with clock changes tested. **E** (HZ-009):
  `packages/domain/src/shared/time.test.ts`, `apps/web/src/lib/uk-time.test.ts`,
  `packages/ui/src/lib/zoned-time.test.ts`, `packages/ui/src/components/DateInput/DateInput.test.tsx`.
- **A6.4** Sync streams carry only assigned people and tenants (replication bypasses RLS, so the
  streams are tested separately). **E** (HZ-011, HZ-028): `packages/sync/test/care-streams.test.ts`,
  `packages/sync/test/task-handover-streams.test.ts`, `packages/db/test/sync-publication.test.ts`.
- **A6.5** A server-side sign-out does not clear a carer's offline records; the browser idle timeout
  is off and refused in production until entries survive it. **E** (HZ-110, HZ-111):
  `apps/api/test/flags-and-sessions.test.ts`, `apps/api/test/config.test.ts`.
- **A6.6 (weakness)** The device-side controls (sync banner, held entries, upload, conflict review;
  HZ-002, HZ-006, HZ-040) have unit tests in `apps/mobile` and `packages/ui-native`, but the only
  end-to-end proof, `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml`, is "Written;
  not run in CI" and the mobile work is paused. Section 2.3 excludes mobile use for care.

### C7. Safety-relevant work reaches the person who must act

- **A7.1** Urgent results and overdue tasks raise alerts routed only to staff who can see the
  person, and say who an alert actually reached. **E** (HZ-014, HZ-073):
  `apps/api/test/care-follow-ups.test.ts`, `apps/api/test/routing-roles.test.ts`,
  `apps/api/test/scope-per-permission.test.ts`, `packages/domain/src/care/fluid-balance.test.ts`.
- **A7.2** The handover includes every safety-critical item kind and records acknowledgement. **E**
  (HZ-018): `packages/domain/src/care/handover.test.ts`, `packages/db/test/handover.test.ts`,
  `apps/web/src/components/care/HandoverActions.test.tsx`, `apps/web/e2e/handover.spec.ts`.
- **A7.3** Statutory notifications are drafted by the classifier with deadline clocks; only
  `safety.notification.submit` holders submit, with step-up; forms never assume an answer; an
  incident cannot be closed from a stale page. **E** (HZ-013, HZ-090, HZ-091): `apps/api/test/incidents.test.ts`,
  `packages/db/test/mca-and-incidents.test.ts`, `apps/web/e2e/incidents.spec.ts`,
  `apps/web/e2e/statutory-notifications.spec.ts`, `apps/web/e2e/incident-forms.spec.ts`,
  `apps/web/e2e/incident-review.spec.ts`.
- **A7.4** Post-fall observations become tasks, with a head-injury pathway. **E** (HZ-027):
  `apps/web/src/lib/incident-forms.test.ts`, `apps/web/e2e/incident-forms.spec.ts`,
  `apps/api/test/onboarding-decisions.test.ts`.
- **A7.5** DoLS expiry clocks and capacity and consent validity show where care is planned. **E**
  (HZ-020, HZ-026): `apps/api/test/mca.test.ts`, `apps/web/src/lib/mca.test.ts`,
  `apps/web/e2e/capacity.spec.ts`.
- **A7.6** Alert volume is held down: overdue tasks escalate once after a grace period, repeated
  changes raise one review, and a late handover addition interrupts only for what cannot wait. **E**
  (HZ-008): `packages/domain/src/platform/tasks.test.ts`, `apps/api/test/tasks.test.ts`,
  `packages/domain/src/people/reviews.test.ts`, `packages/domain/src/care/handover.test.ts`.
- **A7.7 (weakness)** Planned: escalation of an unacted notification clock to the Nominated
  Individual (HZ-013), escalation of an urgent assessment alert until acknowledged (HZ-014), the
  notification tier rules (HZ-008).

### C8. Information is disclosed only within scope and under a recorded decision

- **A8.1** Tenant isolation and attribute scope hold in Postgres, the API and the sync streams.
  **E** (HZ-011): `packages/db/test/rls-coverage.test.ts`, `packages/db/test/isolation.test.ts`,
  `packages/db/test/definer-acls.test.ts`, `packages/db/test/scope.test.ts`,
  `apps/api/test/scope-per-permission.test.ts` (ADR-0071), `packages/sync/test/streams.test.ts`.
- **A8.2** The family feed is closed until a sharing decision exists, has no clinical kinds, and
  notifications carry a generic line only. **E** (HZ-022, HZ-060, HZ-061):
  `packages/domain/src/comms/feed-visibility.test.ts`, `packages/domain/src/comms/feed-text-review.test.ts`,
  `packages/domain/src/comms/notify-plan.test.ts`, `apps/api/test/feed-publish.test.ts`,
  `apps/api/test/adapters.test.ts`, `apps/web/e2e/family-updates.spec.ts`.
- **A8.3** The inspector evidence pack withholds third parties and is watermarked on every page.
  **E** (HZ-050): `packages/domain/src/quality/evidence-pack.test.ts`,
  `apps/api/test/evidence-packs.test.ts`, `apps/api/test/evidence-link.test.ts`,
  `apps/api/test/evidence-pack-pdf.test.ts`.
- **A8.4** Letters use approved templates and the right person's details. **E** (HZ-051):
  `packages/domain/src/comms/templates.test.ts`, `apps/api/test/letters.test.ts`,
  `apps/web/e2e/letters.spec.ts`.
- **A8.5** The full export needs step-up and is complete or never offered. **E** (HZ-070, HZ-071):
  `packages/domain/src/platform/export.test.ts`, `packages/db/src/export-catalogue.test.ts`,
  `apps/api/test/export-worker.test.ts`, `apps/web/e2e/export.spec.ts`.
- **A8.6** Care records need a second factor used in the same session (ADR-0072). **E** (HZ-112):
  `apps/api/test/mfa-session-factor.test.ts`, `apps/api/test/step-up-factor.test.ts`.
- **A8.7** Sample data is marked and kept apart from real records. **E** (HZ-072):
  `packages/db/test/sample-data.test.ts`, `apps/api/test/sample-data.test.ts`,
  `apps/web/e2e/sample-data.spec.ts`.

### C9. Care can continue during an IT outage and paper records come back safely

- **A9.1** A nightly downtime pack per location says how fresh it is; back-entry marks paper records
  and reconciliation needs each entry checked. **E** (HZ-021, HZ-092, HZ-017):
  `packages/domain/src/operations/downtime-pack.test.ts`, `packages/db/test/downtime.test.ts`,
  `apps/web/src/lib/downtime.test.ts`, `apps/web/e2e/downtime.spec.ts`, `apps/web/e2e/back-entry.spec.ts`.
- **A9.2 (weakness)** The kiosk's offline copy of the pack (`hazard-HZ-021-kiosk-downtime-pack.yaml`)
  is planned with mobile.

### C10. The screens support safe reading and use

- **A10.1** Components come only from `@harbour/ui`; status is shown by icon plus word, never colour
  alone; British English, sentence case. **E**: `packages/ui/CONTENT.md`;
  `packages/ui/src/components/StatusChip/StatusChip.test.tsx` (cited by HZ-007).
- **A10.2** Every story is checked with axe in light and dark themes, and Storybook builds in CI.
  **E**: `packages/ui/src/test/stories.a11y.test.tsx` (colour contrast is checked in the browser,
  not here, as the test explains).
- **A10.3** Each of the 25 web journeys in `apps/web/e2e` fails on any serious or critical axe result
  (`expectAccessible` in `apps/web/e2e/support.ts`).
- **A10.4 (weakness)** The person's history tab and the choose-organisation page have no journey,
  and Lighthouse CI is not in `ci.yml` ([phase-1-gate.md](../../plans/phase-1-gate.md), section 3).

## 6. Hazards by area

Ratings are severity / likelihood / risk level. "Target residual" is the rating expected with every
listed control verified; it is an engineering proposal awaiting the CSO. All 45 hazards are `open`:
none can be `controlled` before a CSO accepts it.

| Area | Hazard | Initial | Target residual |
| --- | --- | --- | --- |
| Identification and essential information | HZ-001 Wrong-person record selection | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-007 Incorrect or missing allergy display | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-015 Resuscitation decision missing, out of date or not visible | Major / Low / 3 | Major / Very low / 2 |
| | HZ-016 Wrong IDDSI diet or fluid texture | Major / Low / 3 | Major / Very low / 2 |
| | HZ-023 Essential information missing from the hospital transfer pack | Major / Medium / 3 | Major / Low / **3** |
| | HZ-028 Point-of-care history on a device mistaken for the complete record | Considerable / Medium / 3 | Considerable / Low / 2 |
| Offline, sync, sessions and time | HZ-002 Stale offline data shown as current | Major / Medium / 3 | Major / Low / **3** |
| | HZ-006 Silent sync failure | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-009 Time-zone and daylight-saving errors | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-010 Device clock drift | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-029 An entry recorded twice when a save is tried again | Considerable / Medium / 3 | Considerable / Low / 2 |
| | HZ-040 Held entries deleted to get past the lockout | Major / Medium / 3 | Major / Low / **3** |
| | HZ-110 A server-side sign-out clears a carer's offline records | Major / Low / 3 | Major / Very low / 2 |
| | HZ-111 A browser idle timeout loses an unsaved care entry | Major / Medium / 3 | Major / Very low / 2 |
| Assessments, care plans and recording | HZ-012 Validated tool calculated incorrectly | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-014 Deterioration score or screening trigger not acted on | Major / Medium / 3 | Major / Low / **3** |
| | HZ-017 Late or retrospective entry mistaken for contemporaneous | Considerable / Medium / 3 | Considerable / Low / 2 |
| | HZ-019 Body-map side or site recorded wrongly | Considerable / Medium / 3 | Considerable / Low / 2 |
| | HZ-024 Care plan or risk assessment out of date, or a superseded version followed | Considerable / Medium / 3 | Considerable / Low / 2 |
| | HZ-025 Bed rail entrapment risk not identified | Major / Low / 3 | Major / Very low / 2 |
| Tasks, handover and alerts | HZ-008 Alert fatigue | Major / Medium / 3 | Major / Low / **3** |
| | HZ-018 Safety-critical item omitted from shift handover | Major / Medium / 3 | Major / Very low / 2 |
| Consent, capacity and DoLS | HZ-020 Deprivation-of-liberty authorisation lapses unnoticed | Considerable / Medium / 3 | Considerable / Low / 2 |
| | HZ-026 Restrictive or covert care without valid consent or authority | Considerable / Medium / 3 | Considerable / Low / 2 |
| Incidents and notifications | HZ-013 Statutory notification missed or late | Major / Medium / 3 | Major / Low / **3** |
| | HZ-027 Head injury after a fall not observed or escalated | Major / Medium / 3 | Major / Low / **3** |
| | HZ-080 Revised statement of purpose not sent to CQC in time | Minor / Medium / 2 | Minor / Low / 1 |
| | HZ-090 An incident form records an assumed answer | Major / Low / 3 | Major / Very low / 2 |
| | HZ-091 Incident closed or notification recorded on a wrong or stale page | Major / Low / 3 | Major / Very low / 2 |
| Continuity | HZ-021 No access to essential information during an IT outage | Major / Low / 3 | Major / Very low / 2 |
| | HZ-092 Paper records confirmed as reviewed without being found | Considerable / Medium / 3 | Considerable / Low / 2 |
| Access, confidentiality and disclosure | HZ-011 Cross-tenant or out-of-scope record exposure | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-022 Information shown to family or a professional without a sharing decision | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-050 Evidence pack exposes a third party or a person outside its scope | Considerable / Medium / 3 | Considerable / Very low / 2 |
| | HZ-051 Letter carries another person's details or unapproved wording | Considerable / Medium / 3 | Considerable / Low / 2 |
| | HZ-060 Health details in a notification to a family member | Considerable / Medium / 3 | Considerable / Very low / 2 |
| | HZ-061 Family reassured by a stale or misleading update | Considerable / Medium / 3 | Considerable / Medium / **3** |
| | HZ-070 Full tenant export disclosed beyond the organisation | Major / Low / 3 | Major / Very low / 2 |
| | HZ-073 Safety work hidden from the person who must act because of their scope | Major / Medium / 3 | Major / Low / **3** |
| | HZ-112 Care records opened without a second factor, or staff shut out | Major / Medium / 3 | Major / Low / **3**, then Very low / 2 with the mobile control |
| Data portability and sample data | HZ-071 Full tenant export incomplete or misread on a change of system | Catastrophic / Medium / **4** | Catastrophic / Very low / **3**; recorded as Catastrophic / Low / **4** until the CSO accepts (H-119) |
| | HZ-072 Sample data mistaken for, or mixed with, real records | Considerable / Medium / 3 | Considerable / Low / 2 |
| Medicines (Phase 2; foundations only) | HZ-003 Missed medication administration | Major / Medium / 3 | Major / Low / **3** |
| | HZ-004 Duplicated medication administration | Major / Medium / 3 | Major / Very low / 2 |
| | HZ-005 Unit or dose transcription error | Major / Medium / 3 | Major / Low / **3** (re-assessed at Phase 5) |

## 7. Changes since v0.0

- **Hazards opened**: 32. HZ-014 to HZ-029, HZ-040, HZ-050, HZ-051, HZ-060, HZ-061, HZ-070 to
  HZ-073, HZ-080, HZ-090 to HZ-092 and HZ-110 to HZ-112. The gaps in numbering are reserved blocks;
  no hazard was removed.
- **Hazards changed**: HZ-001 to HZ-013 gained their Phase 1 controls and tests. HZ-071 was opened
  and then re-rated after clinical review from Major to Catastrophic severity (initial risk 4).
- **Hazards closed or transferred**: none.
- **Controls added**: listed per hazard in the log, each with "Built in Phase 1" and its slice.
- **Clinical pull requests merged**: Phase 1 slices 1 to 13 on `main` ([STATUS.md](../../plans/STATUS.md));
  the list of pull requests labelled `clinical` since v0.0 is `[filled at tagging]`.

## 8. Verification status: what is and is not yet verified

| Verification rows in the log | Count |
| --- | --- |
| Passing | 508 |
| Planned for Phase 1 (or without a phase) | 47 |
| Planned for Phase 2 or later (mostly medicines) | 33 |
| Written but not run in CI (the Maestro offline journey, rows in HZ-001 and HZ-006) | 2 |
| Other ("Built in Phase 0" for HZ-010; HZ-051 "covered by" another test) | 2 |
| **Total** | **592** |

Not yet verified, and relevant to this release:

- **Mobile journeys.** `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml` is written
  but `.github/workflows/mobile.yml` builds the app in demo mode, which never syncs, and runs on
  Android only, weekly and on release candidates; there is no iOS job. The other planned Maestro
  flows (HZ-001 no auto-advance, HZ-002 offline banner, HZ-006 sign-out with queue and sync
  recovery, HZ-009 device zone, HZ-021 kiosk pack, HZ-023 offline transfer pack, HZ-027 post-fall
  observations, HZ-072 sample banner) do not exist. Mobile is paused.
- **Review tasks on screen.** HZ-006's `apps/web/e2e/tasks.spec.ts` is planned; the `TaskDetails`
  and `TaskEvidenceBadge` components are unit-tested but no screen shows them, so the nurse in charge
  sees a review task by its title only.
- **Planned Phase 1 tests**, among them: HZ-001 similar-name flag, duplicate check, missing-photo
  placeholder and scope rejection; HZ-002 stale threshold and "last confirmed" panels; HZ-007 "not
  recorded" header state, positive "no known allergies" and eviction survival; HZ-008 tiers and
  push rules; HZ-010 drift over five minutes flagged and the late-entry flag at two hours; HZ-012
  locked templates and on-screen banding table; HZ-013 escalation to the Nominated Individual;
  HZ-014 urgent alert escalation until acknowledged; HZ-040 the stale-device check (H-141); HZ-060
  the notification worker sends the approved template only; HZ-072 a sample incident drafts no
  statutory notification; HZ-092 each reconciled entry opened from the screen; HZ-111 the idle
  warning journey; HZ-112 the mobile handling of an MFA refusal. Some of these controls may be
  partly covered by tests with other names; until the hazard log says so, they count as unverified.
- **Thin coverage** worth CSO attention: HZ-025 (two tests), HZ-080 and HZ-110 (one API test file
  each), HZ-072.
- **Accessibility**: no journey for `/people/[id]/history` or `/choose-organisation`; no Lighthouse CI.
- **CI evidence at the tag**: the run link and the hazard-ID test report are filled at tagging.

## 9. Residual risk

- **Level 5**: none.
- **Level 4**: HZ-071 (full export misread on a change of system) is recorded at Catastrophic / Low /
  4 until the CSO accepts that its controls bring the likelihood to Very low (H-119). **This blocks
  a production release** under the plan, section 3.3, unless the CSO accepts it or a further control
  is added. The import round-trip test is planned with PLAT-014 (Phase 2).
- **Level 3, needing the CSO's recorded acceptance** (13): HZ-002, HZ-003, HZ-005, HZ-008, HZ-013,
  HZ-014, HZ-023, HZ-027, HZ-040, HZ-061, HZ-071 (once accepted at 3), HZ-073 and HZ-112 (until its
  mobile control is built). Each hazard entry gives the justification. The common argument is that
  the remaining risk sits with a human act or decision Harbour cannot take (giving a medicine,
  recognising deterioration, submitting a notification) and that removing it would mean automating a
  clinical or regulated judgement, which the medical-device boundary rules out. Particular points for
  the CSO:
  - HZ-061 is held at its initial rating until the CSO reviews the feed's word lists, holds and
    wording (H-110).
  - HZ-040 stays at 3 until location routing and the meaning of "failed" are confirmed on a device,
    which waits for mobile.
  - HZ-073 depends on how each provider builds its role bundles (deployer control and the access
    report runbook).
  - HZ-112 drops to 2 only when the mobile app handles the MFA refusal.
- **Level 2 and 1**: the remaining 31 hazards, subject to the CSO's review of each rating (H-21).

## 10. Open hazards, outstanding risks and human actions

Every hazard is open. The items below stand between this draft and a release a live tenant could
rely on. None blocks the build; each blocks go-live.

| Item | Human action | Blocks |
| --- | --- | --- |
| Appoint the CSO | H-20 | Everything below |
| Approve the plan; review every rating; accept or reject the level-3 residual risks | H-21 (and the per-hazard rating actions named in the log, such as H-169, H-261, H-265, H-267, H-351, H-353, H-358) | Sign-off |
| First SWIFT workshop; decide the candidate hazards | H-23 | Sign-off |
| Sign v0.0 | H-24 | Any real tenant |
| Review and sign this report (v0.1) | H-381 | Any real tenant on Phase 1 |
| Accept HZ-071's controls or ask for more | H-119 | Production release |
| Regulatory opinion on the validated tools; licence terms for MUST, Waterlow and Braden; authoritative Waterlow source | H-25 | Using the tools with a live tenant; Waterlow and Braden stay off |
| CSO check of the NEWS2 reference vectors and the Care mode evidence | H-129 | Mobile use (paused) |
| Accept ADR-0032 risk assessment rating | H-60 | Risk assessment ratings with a live tenant |
| Design-partner home runs a day on two phones and a tablet | H-56 | Phase 1 human gate |
| Medical-device boundary statement approved by the CSO | Boundary document, section 8 | Sign-off |

Known defects and gaps with clinical relevance (from [phase-1-gate.md](../../plans/phase-1-gate.md)):

- Web screens are missing for 22 Phase 1 rows whose rules are API-only (people lifecycle, documents,
  tasks and retention, candour, medical examiner, investigations, evidence pack composing, statement
  of purpose). Staff cannot see review tasks on screen (HZ-003, HZ-004, HZ-006).
- No user guides exist, so the "Training and user documentation" controls in the log, which every
  hazard relies on in part, are not yet in place.
- The onboarding item for shared and kiosk devices stays open because Harbour does not yet record
  device modes; it blocks go-live by design (HZ-001, HZ-072).
- The DPIA template has no Phase 1 risks (a data-protection gap that overlaps HZ-050, HZ-051 and
  HZ-070).

## 11. Deployer information

No tenant may use this release for real people until this report is signed. When it is, the tenant's
DCB0160 assessment ([template](../dcb0160-deployment-template.md)) must cover these deployer controls,
taken from the hazard log:

- Use the **web app only** for care in this release; the mobile app is not covered (section 2.3).
- Keep the **paper MAR** and the fire file current until the eMAR and PEEPs are in Harbour (HZ-021).
- **Photos** taken at admission and refreshed under the provider's policy; every current person has a
  photo before go-live (HZ-001).
- **Allergy status** recorded at admission and at medicines reconciliation (HZ-007).
- **Escalation policies** linked for each validated tool switched on, and escalation chains and an
  on-shift nurse in charge set per location (HZ-012, HZ-014, H-122).
- **Role bundles** reviewed before go-live with the pre-deployment access report, so the people who
  must act on safety work can open the record ([runbook](../../runbooks/data-scope-per-permission-access-report.md);
  HZ-011, HZ-073).
- **Verbal handover** of critical changes at shift change (HZ-002); handover covers open wounds and
  charts with a trend (HZ-028).
- **Downtime pack**: the business continuity plan says where the printed pack is kept, who prints it,
  and that superseded packs are shredded; reconcile paper records with the forms in hand (HZ-021,
  HZ-092).
- **Policies** for notifications and acting-up (HZ-013), post-fall care (HZ-027), the Mental
  Capacity Act (HZ-026), care planning reviews (HZ-024), hospital transfer and the red bag (HZ-023),
  bed rail measurement (HZ-025), communication with families by phone for incidents, admissions,
  deterioration and deaths (HZ-060, HZ-061), sharing decisions reviewed at each care plan review
  (HZ-022).
- **Evidence packs**: the quality lead reviews the redaction preview before a second person releases
  (HZ-050). **Letters**: starter wording reviewed; candour letters signed off by the Registered
  Manager (HZ-051).
- **Exports**: downloaded only to a managed, encrypted device and deleted after use; a receiving
  provider reconciles row counts and checks essentials person by person (HZ-070, HZ-071).
- **Sessions**: a carer is signed out mid-shift only for a lost device, departure, suspension or
  suspected misuse (HZ-110).
- **Access review** at intervals set by the provider (HZ-011); managers review the monthly alert
  report (HZ-008).

## 12. Known limitations

- Every rating is an engineering proposal; no CSO has reviewed any of them.
- No SWIFT workshop has been held; hazard identification is from the specification, guidance,
  failure analysis and pull request review.
- The mobile app is out of scope (paused); offline point-of-care use is not claimed.
- Medicines are not built; HZ-003 to HZ-005 rest on paper processes.
- Waterlow and Braden are off for every tenant until H-25 closes.
- Training and user documentation controls do not exist yet (no user guides).
- The hazard log is Markdown; the NHS assurance-format export arrives in Phase 5.
- This report is drafted against `main` before tagging; the tag, commit and CI evidence are filled at
  tagging, and any change between this draft and the tag needs a delta.

## 13. Sign-off

**Clinical Safety Officer approval: pending.** Harbour engineering cannot sign this report. The CSO's
review and signature, and top management's acknowledgement, are logged as H-381 in
[docs/plans/human-actions.md](../../plans/human-actions.md). The CSO's acceptance of each level-3
residual risk (section 9) is recorded here when given.

| Role | Name | Registration | Date | Signature |
| --- | --- | --- | --- | --- |
| Clinical Safety Officer | `[CSO name - human action]` | `[professional body and number - human action]` | `[date]` | `[signature - human action]` |
| Top management | `[Brian, Thapsus director - human action]` | Not applicable | `[date]` | `[signature - human action]` |

| Level-3 residual risk accepted | CSO decision |
| --- | --- |
| HZ-002, HZ-003, HZ-005, HZ-008, HZ-013, HZ-014, HZ-023, HZ-027, HZ-040, HZ-061, HZ-071, HZ-073, HZ-112 | `[CSO acceptance or rejection per hazard - human action]` |
