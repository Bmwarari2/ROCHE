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

**Note (31/10/2026)**: production hosting moved from AWS eu-west-2 to Google Cloud europe-west2
(London) by [ADR-0098](../../decisions/0098-production-on-google-cloud.md). This version is left as
issued; the next safety case version ([v0.2](safety-case-v0.2-phase2.md)) carries the change.

## Document control

| Version | Date | Status | Change |
| --- | --- | --- | --- |
| 0.1 draft A | 31/10/2026 | Draft | First draft for the Phase 1 gate |
| 0.1 draft B | 31/10/2026 | Draft | Clinical-safety review round 1 (by the `clinical-safety-reviewer` agent, not a clinician): open human actions counted and grouped; level-3 risks rated for a web-only release; system definition, assumptions, configuration defaults, decisions for the CSO, conclusions and this table added; evidence corrected where it overclaimed |

**Distribution**: Thapsus engineering; Brian (top management); the CSO once appointed. Not for
tenants until signed. Once signed, it is exported to PDF and supplied to tenants with the release
notes ([README](README.md)).

**Owner and review**: the CSO owns this report once appointed. It is reviewed at tagging (to fill
the tag, commit and CI evidence) and whenever a change before the tag alters a hazard rating.

## 1. Purpose

This report summarises the clinical safety case for the Phase 1 residential MVP: the first Harbour
release with clinical functions that care workers, nurses and managers use to record and act on care.
It sets out what the release does, the safety claim made for it, the argument and the evidence for
that claim, the hazards and their ratings, what has not yet been verified, what is still to be
decided, and what a deploying provider must put in place.

It builds on [v0.0](safety-case-v0.0-phase0.md). Neither report is signed. Harbour cannot sign its
own safety case: the ratings and residual risks below are engineering proposals until a Clinical
Safety Officer reviews and accepts them (sections 13 and 17).

## 2. System definition

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
members reading the feed. The intended setting is a care home in England. The intended means of use
in this release is the **web app** (section 2.4).

### 2.2 What the Phase 1 release contains

Scope is the Phase 1 rows of the [feature register](../../specs/feature-register.md) and
[phase-1.md](../../plans/phase-1.md). None of the 54 rows is `done` under the definition of done
(section 19), mainly because user guides are missing ([phase-1-gate.md](../../plans/phase-1-gate.md),
section 6); the table says what is built.

| Area | Built in this release | Main hazards |
| --- | --- | --- |
| People lifecycle (residential) | Person record, communication needs, About Me, pre-admission, admission with rooms and property, review scheduling, hospital transfer pack, discharge, transfer and death with a read-only archive, sharing rules (API; some web screens) | HZ-001, HZ-007, HZ-015, HZ-016, HZ-022, HZ-023 |
| Care record | Care plans and versions, risk assessments, daily notes, five charts (fluids, food with IDDSI, repositioning, bowel, weight) and vital signs, body map, activities and visits, advance care records, history views | HZ-012, HZ-014 to HZ-017, HZ-019, HZ-024, HZ-025, HZ-028 |
| Validated tools | NEWS2, MUST, Waterlow and Braden (Waterlow and Braden off by default), and the NICE NG249 falls pathway (no score), calculated on the server, with the tenant's escalation policy linked | HZ-012, HZ-014 |
| Tasks, rounds and handover | Care plan actions generate shift tasks (never for the medicines domain); round view; overdue escalation; handover compiled from the shift's records with acknowledgement | HZ-003, HZ-008, HZ-018, HZ-024 |
| Consent, capacity and DoLS | Consent records, two-stage capacity assessment, best-interests checklist, DoLS register with expiry clocks and the 2026 legal-change review | HZ-020, HZ-026 |
| Incidents and notifications | Incident capture, classifier (CQC regulations 16 and 18, RIDDOR, safeguarding, candour, LeDeR and others), deadline clocks, statutory notification drafts with step-up submission, post-fall checklist, candour, investigations (API) | HZ-013, HZ-027, HZ-090, HZ-091 |
| Continuity | Nightly downtime pack per location, outages and back-entry of paper records with reconciliation | HZ-017, HZ-021, HZ-092 |
| Disclosure | Inspector evidence pack (watermarked PDF, time-limited link), letters and templates, family feed under a recorded sharing decision, full tenant export, search and break-glass search | HZ-011, HZ-022, HZ-050, HZ-051, HZ-060, HZ-061, HZ-070, HZ-071, HZ-073 |
| Platform | Task and workflow engine, document store, retention and legal hold, onboarding checklist, sample data mode, sessions and MFA for care records, DPIA sign-off | HZ-006, HZ-072, HZ-110 to HZ-112 |
| Offline Care mode (mobile) | Built in part (notes, charts, round actions, device holds, sync streams scoped to assignments). Paused by the owner from 16 to 31 October 2026 and resumed on 31 October 2026; **not verified for this release** (section 2.4) | HZ-001, HZ-002, HZ-006, HZ-029, HZ-040 |

### 2.3 Interfaces and dependencies

| Component | What it is in this release | Safety relevance |
| --- | --- | --- |
| Hosting | Production: AWS eu-west-2 ([ADR-0008](../../decisions/0008-production-hosting.md)), not yet provisioned: even the AWS dev account is an open action (H-04). Dev and staging: Supabase London is allowed (ADR-0008) | Availability of the record; the downtime pack is the continuity path (HZ-021) |
| Database | Postgres 17 with forced row-level security and a non-owner application role ([ADR-0002](../../decisions/0002-tenancy-and-row-level-security.md)) | HZ-011, HZ-073 |
| API and job worker | Hono API; background jobs on pg-boss (`apps/api/src/jobs`): escalation sweeps, the nightly downtime pack, exports, reports | If the worker stops, escalations and the nightly pack stop. HZ-021 names a failed rebuild; no hazard yet names worker failure as a cause of missed escalation (a candidate for the CSO workshop) |
| Sign-in | Better Auth with passkeys and TOTP ([ADR-0009](../../decisions/0009-identity-provider.md)); MFA judged per session ([ADR-0072](../../decisions/0072-mfa-counts-only-for-the-session-that-used-it.md)) | HZ-110 to HZ-112 |
| Sync | PowerSync streams and the upload API for the mobile app ([ADR-0029](../../decisions/0029-mobile-offline-stack.md); `packages/sync`, `apps/api/src/sync`) | Only the mobile app uses it; out of scope for use (2.4), but the streams are tested for isolation (HZ-011) |
| Notifications | Email through Amazon SES; SMS through a UK gateway not yet chosen; push through Expo ([sub-processors](../../compliance/sub-processors.md)). SMS and push run against mocks (INTG-011) | HZ-008, HZ-013, HZ-060. Delivery outside the app is not yet proven end to end |
| PDF generation | A small in-house PDF writer, `apps/api/src/services/pdf.ts` ([ADR-0040](../../decisions/0040-transfer-pack-pdf-writer.md), proposed; H-81, H-84), for the transfer pack, downtime pack, evidence pack and letters | HZ-021, HZ-023, HZ-050, HZ-051 |
| Document storage | S3 with SSE-KMS in AWS, local files in development ([ADR-0031](../../decisions/0031-document-storage-scanning-and-destruction.md)) | Signed forms and attachments |
| Rate table | Statutory figures and Harbour defaults, seeded from [rates.md](../../specs/rates.md) (section 7) | Every interval and threshold the rules apply |
| Feature flags | OpenFeature, the organisation's own rows, then Flagsmith, then the defaults in `packages/domain/src/platform/feature-flags.ts` | Waterlow and Braden off (HZ-012); AI off; no flag for Care mode (2.4) |

### 2.4 Out of scope for this report

- **Medicines and eMAR** (Phase 2). No medicines administration, MAR, controlled drugs or pharmacy
  interface is built. HZ-003, HZ-004 and HZ-005 are carried with the Phase 1 controls that touch them
  and their medicines controls planned. The provider's paper MAR stays the medicines record (deployer
  control, HZ-021). A care plan action in the medicines domain never makes a round, but medicines
  support written under other domains (creams, thickeners, inhalers) does today (H-151).
- **The mobile app as a point-of-care tool.** The offline Care mode code and its unit tests exist and
  are cited where they verify a control. But:
  - the Maestro offline journey has not run in CI against a syncing build;
  - there is no iOS simulator job;
  - the conflict review has not been demonstrated on a device;
  - kiosk mode and device-mode recording are not finished;
  - store readiness (MOB-011, MOB-012) is not started.

  This report makes **no claim that the mobile app is safe to use for care**. Until a later report
  covers it, deployers use the web app only.
- **The exclusion is a control, not an instruction** (recommended answer to H-381, applied
  31/10/2026 for review at the testing phase). The organisation-wide flag `care.mobile_care_mode`
  (`packages/domain/src/platform/feature-flags.ts`) is off by default: while it is off the phone
  refuses Care mode sign-in (`apps/mobile/src/app-state/care-mode-gate.ts`; a phone holding unsent
  entries still admits a sign-in so they can be handed over or their deletion recorded), and the API
  refuses the sync token, the batch upload and a phone's entry uploads with 403 `feature_disabled`
  (`refuseCareModeOff` in `apps/api/src/services/devices.ts`), which the phone reads as access
  withdrawn, holding unsent entries under the hold rules. Only the demo tenant (invented data) has it
  on. The `eas-build` job in `.github/workflows/mobile.yml` builds no store binary unless the
  repository variable `MOBILE_SAFETY_CASE_COVERS_APP` is `true`, which the owner sets only once a
  signed safety case covers the app.
- Home care, supported living, the family app mode, nation packs and every Phase 2 to 7 module.
- The optional AI module: not built and off by default.
- The deploying provider's devices, networks, training and local practice (the tenant's DCB0160
  work; [DCB0160 deployment template](../dcb0160-deployment-template.md)).

### 2.5 Deployment status

The release runs in `dev` and `staging` with the demo tenant and invented people only. It is not
deployed for any real person. The design partner home (H-56, [ADR-0005](../../decisions/0005-design-partner.md))
has not yet run a day on it.

## 3. Clinical risk management system

The process is the [clinical risk management plan](../clinical-risk-management-plan.md) (draft v0.1,
not yet approved). In summary:

| Element | State at this report |
| --- | --- |
| Risk matrix and acceptability | DCB0129's five-by-five matrix unchanged (plan, sections 3.2 and 3.3). Level 4 or 5 residual risk blocks a production release; level 3 needs the CSO's recorded acceptance |
| Hazard log | [hazard-log.md](../hazard-log.md), in Git beside the code; 45 hazards, IDs never reused |
| Hazard identification | So far from the master specification, the regulator and clinical guidance named in each spec, failure analysis of sync, clocks, tenancy and authentication, and pull request reviews. **No CSO-led SWIFT workshop has been held** (H-23) |
| Pull request controls | The PR template asks every PR for its clinical-safety impact and the medical-device boundary question (`.github/pull_request_template.md`). The CI docs gate (`scripts/check-docs-gate.mjs`) fails a PR **labelled** `clinical` that leaves the hazard log and the safety case untouched; it cannot catch a clinical PR whose author did not label it. CODEOWNERS (`.github/CODEOWNERS`) routes `docs/clinical-safety/` to the repository owner, not to a clinician |
| Traceability | Tests that verify a control name their hazard ID, so `grep -rn "HZ-0" apps packages` finds the evidence; each hazard's Verification table lists the tests and their status. Exceptions exist: the NG249 falls pathway's "no score" test (`packages/domain/src/care/falls.test.ts`, the block from line 179) names no hazard and has no row in the log |
| Roles | Top management: Brian (Thapsus). CSO: **not appointed** (H-20). Until then no hazard can be set `controlled`, and every rating is an engineering proposal |
| Post-deployment monitoring | Planned (plan, section 8); nothing to monitor until a live tenant |

**What "clinical review" means in the log and in this report.** No clinician has reviewed any part of
Harbour. Where the hazard log or a pull request says "clinical review", "clinical reviews C7" or
"re-rated after the clinical review", it means a review by the `clinical-safety-reviewer` agent
(`.claude/agents/clinical-safety-reviewer.md`), an AI reviewer that supports the CSO and never
replaces one. Its findings are engineering input, not clinical acceptance.

## 4. Assumptions

The claim in section 5 holds only while these are true. Each is for the CSO to confirm or reject.

1. The provider uses the **web app only** for care in this release, and keeps the mobile app off its
   staff's devices (enforced by instruction only; section 2.4).
2. The provider is a CQC-registered residential or nursing home in England, with its own policies
   for escalation, notifications, post-fall care, the Mental Capacity Act, safeguarding and
   communication with families, and the staff trained in them.
3. The **paper MAR** is the medicines record, kept current beside Harbour (HZ-021).
4. Staff have a working connection while using the web app; during an outage they use the printed
   downtime pack and back-enter afterwards (HZ-021, HZ-092).
5. The provider completes its DCB0160 assessment and puts the deployer controls in section 14 in
   place before go-live.
6. Rate-table figures marked `to-verify` (section 7) are confirmed, or changed by the provider,
   before a real person relies on them.
7. The validated tools' publishers permit their use in software, and the regulatory position on the
   tools holds (H-25).
8. Production runs as ADR-0008 describes (AWS eu-west-2, Multi-AZ, point-in-time recovery), which is
   not yet provisioned (the AWS dev account is still H-04).

## 5. Clinical safety claim

> When deployed and used as described in this report, on the web app, under the assumptions in
> section 4 and with the deployer controls in section 14 in place, the Phase 1 residential MVP is
> acceptably safe for its intended use, subject to the CSO's review of the ratings, the decisions in
> section 13, the acceptance of the level-3 residual risks in section 11, and the closing of the
> items in section 12 that block go-live.

The claim is **not yet supported** for a live tenant: no CSO has reviewed the evidence, HZ-071's
residual risk is recorded at level 4 until the CSO accepts its controls, and 106 open human actions
owned by the CSO (section 12) stand between this draft and a real person. The claim holds today only
for `dev` and `staging` with demo data.

## 6. Safety argument and evidence

Claims (C), the arguments (A) that support them, and the evidence (E). Every file path below was
checked to exist on `main` at `aae5ab5`. "Weakness" marks what the evidence does not show.

### C1. Clinical risk management is established and applied to Phase 1

- **A1.1** The process is documented and the file is complete for this stage. **E**: the
  [plan](../clinical-risk-management-plan.md), [hazard log](../hazard-log.md), this report and
  [v0.0](safety-case-v0.0-phase0.md), the [DCB0160 template](../dcb0160-deployment-template.md).
- **A1.2** A pull request labelled `clinical` cannot merge without touching the safety documents.
  **E**: `scripts/check-docs-gate.mjs` (CI job "Lint, types, API contract, builds and security" in
  `.github/workflows/ci.yml`); `.github/pull_request_template.md`.
- **A1.3 (weakness)** The gate depends on the author labelling the pull request; CODEOWNERS routes
  the clinical safety folder to the repository owner, not a clinician; the plan is unapproved, the
  CSO is not appointed and no SWIFT workshop has been held (H-20, H-21, H-23). The reviews so far are
  by an AI agent (section 3).

### C2. The Phase 1 hazards are identified and assessed

- **A2.1** The 13 day-one hazards from v0.0 were extended with 32 Phase 1 hazards as each slice
  started, using the `hazard` skill (`.claude/skills/hazard/SKILL.md`). Each has causes, effects, an
  initial rating, controls by type, a target residual rating and verification. **E**: hazard log
  HZ-001 to HZ-029, HZ-040, HZ-050, HZ-051, HZ-060, HZ-061, HZ-070 to HZ-073, HZ-080, HZ-090 to
  HZ-092, HZ-110 to HZ-112.
- **A2.2** The expected Phase 1 hazards in [phase-1.md](../../plans/phase-1.md) are all logged: late
  entries (HZ-017), NEWS2 or MUST trigger not reaching the nurse (HZ-014), DoLS expiry (HZ-020),
  handover omissions (HZ-018), body-map laterality (HZ-019), IDDSI (HZ-016), family feed without a
  sharing decision (HZ-022), downtime pack out of date (HZ-021).
- **A2.3** Every rating follows the plan's matrix; severity, likelihood and risk level agree in every
  entry and in the summary table (checked for this report).
- **A2.4 (weakness)** Three candidate hazards wait for the CSO workshop (log, "Candidate hazards for
  the first CSO workshop"), and the job worker's failure is not yet a named cause (section 2.3).
  Whether HZ-080 belongs in DCB0129 scope at all is open (H-224).

### C3. Controls are implemented and verified by automated tests that run in CI

- **A3.1** Every hazard has at least one automated test that names it. **E**: the Phase 1 gate count
  of 45 of 45 ([phase-1-gate.md](../../plans/phase-1-gate.md), section 4), rechecked for this report
  (every hazard ID appears in at least one test file under `apps` or `packages`).
- **A3.2** Of 592 verification rows in the log, 508 read "Passing". The other 84 are counted in
  section 10 and listed one by one in Appendix A.
- **A3.3** The tests run on every pull request and on `main`: package, domain and database tests
  (with RLS isolation) in the "Unit, domain and RLS isolation tests" job, which also holds domain
  rules at 90% line coverage; web journeys with axe in the "Web journeys and accessibility" job
  (`.github/workflows/ci.yml`). **E**: CI run 38932679711 was green in every job, but on `5b3d238`,
  35 commits (six merges) before `aae5ab5`: sample data (#98, #102), break-glass search (#99), the
  gate evidence (#101) and two documentation merges came after it. The run for the tagged commit is
  `[CI run link - filled at tagging]`.

### C4. Harbour stays inside the medical-device boundary; validated tools are calculated exactly as published

- **A4.1** The boundary is written down and every clinical PR answers the boundary question. **E**:
  [medical-device-boundary.md](../../compliance/medical-device-boundary.md), sections 2 to 7.
- **A4.2** NEWS2, MUST, Waterlow and Braden are versioned tables with their source cited, tested
  table by table against the published charts, card and form (band boundaries, and the BAPEN worked
  examples for MUST). Incomplete or impossible input gives no total; the result stores the tool
  version and workings; the client sends answers, never a score. **E** (HZ-012):
  - in `packages/domain/src/care/`: `news2.test.ts` (with `NEWS2_REFERENCE_VECTORS` in
    `news2-vectors.ts`, points per parameter worked by hand from RCP chart 1), `must.test.ts`,
    `waterlow.test.ts`, `braden.test.ts`, `validated-assessment.test.ts`;
  - `apps/api/test/care-planning.test.ts`; `apps/web/src/lib/assessments.test.ts`;
    `apps/web/e2e/care-record.spec.ts`.
- **A4.3** The NG249 falls pathway returns follow-up tasks and no score. **E**:
  `packages/domain/src/care/falls.test.ts` ("returns no numeric risk score, band or risk level"; this
  test names no hazard, section 3).
- **A4.4** Each result links the tenant's own escalation policy, or says plainly that none is
  configured; Harbour writes none of the policy. **E**:
  `packages/domain/src/care/escalation-policy.test.ts`;
  `apps/web/src/components/care/ObservationList.test.ts`.
- **A4.5** Waterlow and Braden are off for every tenant until their licence terms are confirmed.
  **E**: `packages/domain/src/care/braden.test.ts` asserts both are listed in
  `TOOLS_AWAITING_LICENCE_CONFIRMATION` with their flags off by default; only Braden's refusal with
  the flag off is tested through the API (`apps/api/test/care-planning.test.ts`), not Waterlow's.
- **A4.6** The incident classifier, capacity rules, post-fall checklist, downtime pack, evidence
  pack, letters and family feed add no score or interpretation (boundary document, section 5).
- **A4.7 (weakness)** Boundary rule 2 says the screen shows the published banding. The **full
  published banding table beside the band is not built** (an HZ-012 design control marked Phase 1;
  its Playwright test is planned). **Locked validated templates are not built** either (HZ-012,
  planned). Open decisions:
  - H-73: the web's "No escalation policy is configured for this result. Follow your organisation's
    procedures and tell the nurse in charge." shows on every band, NEWS2 0 included, where the RCP's
    own response is routine monitoring, so it may read as Harbour adding to the published response;
  - H-127: the RCP response and monitoring wording, written for a ward, shown with a NEWS2 score in
    homes without nurses (raised for the phone; the web shows the RCP response and monitoring
    wording too, `apps/web/src/lib/charts.ts`);
  - H-163: the order in which a result finds its escalation policy (location and band first);
  - H-25: the regulatory opinion and licence terms. MUST is on by default although its licence
    terms are part of H-25;
  - the CSO's check of each tool against its source (boundary rule 7; H-129 for the NEWS2 vectors);
  - ADR-0032 on risk assessment rating (H-60).

### C5. The right person is identified and their essential information is shown

- **A5.1** The point-of-care header (photo or initials, names, date of birth, room, allergies,
  communication needs, resuscitation status, IDDSI levels; "not recorded" never blank) heads every
  tab of the web record, every round stop and every handover person. **E** (HZ-001, HZ-007, HZ-015,
  HZ-016): `apps/web/src/lib/care-record.test.ts`,
  `apps/web/src/components/people/PersonHeaderCompact.test.tsx`, `apps/web/e2e/care-record.spec.ts`,
  `apps/api/test/rounds-and-handover.test.ts`, `packages/ui-native/src/logic/person.test.ts`.
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
- **A5.5 (weakness)**:
  - **No web test checks that the photo is shown.** The `PersonHeaderCompact` test's title says "with
    photo" but its fixture has no photo (`photoUrl: null`), and the web record's tests use people
    without photos. The photo on the web header is unverified (the test fix is logged separately).
  - Planned and unverified: the similar-name flag, probable-duplicate check, missing-photo
    placeholder and no-auto-advance controls (HZ-001); "no known allergies" recorded only positively
    and the "not recorded" allergy state in the header component tests (HZ-007).

### C6. Time and record-integrity controls stop records being lost, duplicated or mis-timed

- **A6.1** Entries are append-only with client UUIDs and idempotent inserts; a retried save records
  once. **E** (HZ-029): `packages/db/test/care-record.test.ts`, `apps/web/src/lib/entry-id.test.ts`,
  `apps/api/test/care-follow-ups.test.ts`.
- **A6.2** Entries keep the device's time beside the time the server recorded (Phase 0 columns; the
  log's HZ-010 row "Built in Phase 0" names no test). The clock-drift rule (over five minutes,
  `sync.clock_drift_flag_minutes`) is tested in the domain, and the web says when the device clock
  differed. A note written hours after the event is flagged late; one written on time and synced
  late is not. Paper back-entries are marked. **E** (HZ-010, HZ-017):
  - `packages/domain/src/shared/time.test.ts` ("hazard HZ-010 clock drift");
  - `apps/web/src/components/care/EntryBadges.test.ts`;
  - `apps/api/test/care.test.ts` ("hazard HZ-017 flags a note written hours after the event, not one
    synced late");
  - `apps/api/test/back-entry.test.ts`, `apps/web/e2e/back-entry.spec.ts`.
- **A6.3** UK time is handled once, with clock changes tested. **E** (HZ-009):
  `packages/domain/src/shared/time.test.ts`, `apps/web/src/lib/uk-time.test.ts`,
  `packages/ui/src/lib/zoned-time.test.ts`, `packages/ui/src/components/DateInput/DateInput.test.tsx`.
- **A6.4** Sync streams carry only assigned people and tenants (replication bypasses RLS, so the
  streams are tested separately). **E** (HZ-011, HZ-028): `packages/sync/test/care-streams.test.ts`,
  `packages/sync/test/task-handover-streams.test.ts`, `packages/db/test/sync-publication.test.ts`.
- **A6.5** A server-side sign-out does not clear a carer's offline records; the browser idle timeout
  is off and refused in production until entries survive it. **E** (HZ-110, HZ-111):
  `apps/api/test/flags-and-sessions.test.ts`, `apps/api/test/config.test.ts`.
- **A6.6 (weakness)**:
  - HZ-010's API tests that every uploaded event is stamped with the server-received time, and that a
    device time later than the server-received time raises a review flag, are **planned**; so are
    the sync-level drift flag and the domain test of the two-hour late-entry flag.
  - The device-side controls (sync banner, held entries, upload, conflict review; HZ-002, HZ-006,
    HZ-040) have unit tests in `apps/mobile` and `packages/ui-native`. The only end-to-end proof,
    `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml`, is "Written; not run in CI".
    Section 2.4 excludes mobile use for care.

### C7. Safety-relevant work reaches the person who must act

- **A7.1** An urgent result alert reaches someone who can see the person, follows a fallback order,
  or is audited when no one can be told; routed safety work reaches a person who can act on it.
  **E** (HZ-014, HZ-073): `apps/api/test/care-follow-ups.test.ts` ("an urgent result alert always
  reaches someone or is audited" and "an urgent alert's fallback order"),
  `apps/api/test/routing-roles.test.ts` ("routed safety work reaches someone who can see it and act
  on it"), `apps/api/test/device-integrity.test.ts` ("tells the team leader in charge about an
  urgent review at a home with no nurse"), `apps/api/test/scope-per-permission.test.ts`.
- **A7.2** The handover includes every safety-critical item kind and records acknowledgement. **E**
  (HZ-018): `packages/domain/src/care/handover.test.ts`, `packages/db/test/handover.test.ts`,
  `apps/web/src/components/care/HandoverActions.test.tsx`, `apps/web/e2e/handover.spec.ts`.
- **A7.3** Statutory notifications are drafted by the classifier with deadline clocks; only
  `safety.notification.submit` holders submit, with step-up; forms never assume an answer; an
  incident cannot be closed from a stale page. **E** (HZ-013, HZ-090, HZ-091):
  `apps/api/test/incidents.test.ts`, `packages/db/test/mca-and-incidents.test.ts`,
  `apps/web/e2e/incidents.spec.ts`, `apps/web/e2e/statutory-notifications.spec.ts`,
  `apps/web/e2e/incident-forms.spec.ts`, `apps/web/e2e/incident-review.spec.ts`.
- **A7.4** A fall creates post-fall observation tasks from the rate table, shortened for a head
  injury or anticoagulants, counted from when the person was found, exact across clock changes, and
  with no score. **E** (HZ-027): `packages/domain/src/safety/post-fall.test.ts` ("hazard HZ-027 head
  injury or anticoagulants shorten the observation schedule"); `apps/api/test/incidents.test.ts`
  ("hazard HZ-027 a fall creates the post-fall tasks with the observation schedule, shortened for a
  head injury"). The observation figures are unconfirmed (H-66, section 7).
- **A7.5** DoLS expiry clocks and capacity and consent validity show where care is planned. **E**
  (HZ-020, HZ-026): `apps/api/test/mca.test.ts`, `apps/web/src/lib/mca.test.ts`,
  `apps/web/e2e/capacity.spec.ts`.
- **A7.6** Alert volume is held down: overdue tasks escalate once after a grace period, repeated
  changes raise one review, and a late handover addition interrupts only for what cannot wait. **E**
  (HZ-008): `packages/domain/src/platform/tasks.test.ts`, `apps/api/test/tasks.test.ts`,
  `packages/domain/src/people/reviews.test.ts`, `packages/domain/src/care/handover.test.ts`.
- **A7.7 (weakness)**:
  - Planned: escalation of an unacted notification clock to the Nominated Individual (HZ-013);
    escalation of an urgent assessment alert until acknowledged (HZ-014); the notification tier
    rules (HZ-008).
  - Open decisions: a renewed DoLS authorisation reads "expired" from the API, and nothing checks
    for a gap between authorisations (H-251, HZ-020); the post-fall observation defaults (H-66).

### C8. Information is disclosed only within scope and under a recorded decision

- **A8.1** Tenant isolation and attribute scope hold in Postgres, the API and the sync streams.
  **E** (HZ-011): `packages/db/test/rls-coverage.test.ts`, `packages/db/test/isolation.test.ts`,
  `packages/db/test/definer-acls.test.ts`, `packages/db/test/scope.test.ts`,
  `apps/api/test/scope-per-permission.test.ts` (ADR-0071), `packages/sync/test/streams.test.ts`.
- **A8.2** The family feed is closed until a sharing decision exists, has no clinical kinds, and
  notifications carry a generic line only. **E** (HZ-022, HZ-060, HZ-061):
  `packages/domain/src/comms/feed-visibility.test.ts`,
  `packages/domain/src/comms/feed-text-review.test.ts`,
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
  `apps/web/src/lib/downtime.test.ts`, `apps/web/e2e/downtime.spec.ts`,
  `apps/web/e2e/back-entry.spec.ts`.
- **A9.2 (weakness)** The kiosk's offline copy of the pack (`hazard-HZ-021-kiosk-downtime-pack.yaml`)
  is planned with mobile. The 20 open human actions on downtime packs, outages and back-entry
  (section 12) include whether HZ-021's residual risk is acceptable while the pack's medicines and evacuation
  sections only say where the paper records are (H-102).

### C10. The screens support safe reading and use

- **A10.1** Components come only from `@harbour/ui`; status is shown by icon plus word, never colour
  alone; British English, sentence case. **E**: `packages/ui/CONTENT.md`;
  `packages/ui/src/components/StatusChip/StatusChip.test.tsx` (cited by HZ-007).
- **A10.2** Every story is checked with axe in light and dark themes, and Storybook builds in CI.
  **E**: `packages/ui/src/test/stories.a11y.test.tsx` (colour contrast is checked in the browser,
  not here, as the test explains).
- **A10.3** Each of the 25 web journeys in `apps/web/e2e` fails on any serious or critical axe result
  (`expectAccessible` in `apps/web/e2e/support.ts`).
- **A10.4 (weakness)** On `aae5ab5` the person's history tab and the choose-organisation page have no
  journey, and Lighthouse CI is not in `ci.yml` ([phase-1-gate.md](../../plans/phase-1-gate.md),
  section 3). The history tab journey is in a separate pull request about to merge; this paragraph
  and section 10 are refreshed at tagging.

## 7. Safety-relevant configuration defaults

Intervals and thresholds the rules apply come from the rate table ([rates.md](../../specs/rates.md)),
never from code. Its status column says whether a figure was confirmed on an official page
(`verified`), is taken from the master specification (`master-prompt`), or must be confirmed before a
real tenant relies on it (`to-verify`). No CSO has confirmed any of them.

| Figure (rate-table key) | Default | Status | Hazard | Human action |
| --- | --- | --- | --- | --- |
| Post-fall monitoring period (`falls.monitoring_hours`) | 24 hours | to-verify (regional pathway, not NICE) | HZ-027 | H-66 |
| Head-injury observations (`falls.head_injury_obs.*`) | Every 30 minutes for 2 hours, hourly for 4 hours, then 2-hourly | to-verify (NICE NG232 1.9.11, written for hospital) | HZ-027 | H-66 |
| Late-entry threshold (`care_note.late_entry_hours`) | 2 hours | master-prompt | HZ-010, HZ-017 | None |
| Clock-drift flag (`sync.clock_drift_flag_minutes`) | 5 minutes | master-prompt | HZ-010 | H-72 |
| Care plan review (`care_plan.review_interval_months`) | Monthly | master-prompt | HZ-024 | None |
| MUST rescreening in care homes (`must.care_home.screening_interval_months`) | Monthly | master-prompt | HZ-014 | None |
| Weighing (`weight.default_interval_months`, `weight.at_risk_interval_weeks`) | Monthly; weekly when at risk | master-prompt | HZ-012, HZ-014 | None |
| Repositioning (`repositioning.interval_hours.*`) | 6 hours at risk; 4 hours high risk | master-prompt | HZ-008, HZ-009 | None |
| Bed rail gaps and height (`bed_rail.*`) | MHRA figures (for example 120 mm between bars, 220 mm height) | verified (MHRA, gov.uk) | HZ-025 | None |
| DoLS expiry reminders (`dols.expiry_reminder_days.*`) | 28 and 7 days before expiry | to-verify | HZ-020 | None named |
| Overdue task escalation (`task.overdue_escalation_minutes`) | 30 minutes | to-verify | HZ-003, HZ-008 | None named |
| Care plan round window (`care_plan.task_window_before_minutes`, `..._after_minutes`) | 30 minutes before; 60 after | to-verify | HZ-008 | H-150 |
| Statutory notification escalation (`statutory_notification.escalation_minutes`) | 60 minutes | to-verify | HZ-013 | H-69 |
| Handover shifts and acknowledgement (`handover.*`) | Day from 08:00, night from 20:00; nurse in charge told after 60 minutes | to-verify | HZ-018 | H-153 |
| Return-from-hospital checks (`people.return_checks_due_hours`) | Due 24 hours after the return | to-verify | HZ-023 | H-85 |
| Downtime pack validity (`downtime_pack.valid_hours`) | 36 hours | to-verify | HZ-021 | H-101, H-209 |
| Possible duplicate window at reconciliation (`downtime.duplicate_match_minutes`) | 10 minutes | to-verify | HZ-092 | None named |
| Bowel prompt (`bowel.no_movement_prompt_days`) | 3 days | to-verify | HZ-009 | None named |
| Browser idle timeout (`session.idle_timeout_minutes`) | 30 minutes (15 for the owner); off in production | to-verify | HZ-111 | H-350, H-353 |

Other safety-relevant defaults are product constants, not rate-table figures: the web header's
re-read interval (`HEADER_REFRESH_INTERVAL_MS`, HZ-002) and Waterlow and Braden off by default
(HZ-012).

## 8. Hazards by area

Ratings are severity / likelihood / risk level. "Target residual" is the rating expected with every
listed control verified; it is an engineering proposal awaiting the CSO. All 45 hazards are `open`:
none can be `controlled` before a CSO accepts it. Section 11 rates the level-3 hazards for a
web-only release.

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

## 9. Changes since v0.0

- **Hazards opened**: 32. HZ-014 to HZ-029, HZ-040, HZ-050, HZ-051, HZ-060, HZ-061, HZ-070 to
  HZ-073, HZ-080, HZ-090 to HZ-092 and HZ-110 to HZ-112. The gaps in numbering are reserved blocks;
  no hazard was removed.
- **Hazards changed**: HZ-001 to HZ-013 gained their Phase 1 controls and tests. HZ-071 was opened
  and then re-rated after the agent's review from Major to Catastrophic severity (initial risk 4).
- **Hazards closed or transferred**: none.
- **Controls added**: listed per hazard in the log, each with "Built in Phase 1" and its slice.
- **Clinical pull requests merged**: Phase 1 slices 1 to 13 on `main` ([STATUS.md](../../plans/STATUS.md));
  the list of pull requests labelled `clinical` since v0.0 is `[filled at tagging]`.

## 10. Verification status: what is and is not yet verified

| Verification rows in the log | Count |
| --- | --- |
| Passing | 508 |
| Planned for Phase 1 (or without a phase) | 47 |
| Planned for Phase 2 or later (32 for Phase 2, mostly medicines; 1 for Phase 4) | 33 |
| Written but not run in CI (the Maestro offline journey, rows in HZ-001 and HZ-006) | 2 |
| Other ("Built in Phase 0" for HZ-010; HZ-051 "covered by" another test) | 2 |
| **Total** | **592** |

Every row that is not "Passing" is listed in Appendix A. Those most relevant to this release:

- **Mobile journeys.** `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml` is written,
  but `.github/workflows/mobile.yml` builds the app in demo mode, which never syncs, and runs it on
  Android only, weekly, on demand and on release candidates; there is no iOS job. The other planned
  Maestro flows do not exist.
- **Review tasks on screen.** HZ-006's `apps/web/e2e/tasks.spec.ts` is planned. The `TaskDetails`
  and `TaskEvidenceBadge` components are unit-tested but no screen shows them, so the nurse in charge
  sees a review task by its title only.
- **Server-received time.** HZ-010's API tests that every uploaded event is stamped with
  server-received time, and that a device time later than it raises a review flag, are planned.
- **Validated tools.** The on-screen banding table and locked templates are not built (HZ-012).
- **Escalation.** HZ-013's escalation to the Nominated Individual and HZ-014's escalation until
  acknowledged are planned.
- **The web photo** in the point-of-care header has no test (A5.5).
- **Thin coverage** worth CSO attention: HZ-025 (two tests), HZ-080 and HZ-110 (one API test file
  each), HZ-111 (one passing row, its journey planned), HZ-072.
- **Accessibility**: no journey for `/people/[id]/history` or `/choose-organisation` on `aae5ab5`
  (the history journey is about to merge); no Lighthouse CI.
- **CI evidence at the tag**: the run link and the hazard-ID test report are filled at tagging; the
  last green run cited is on an earlier commit (A3.3).

Some planned controls may be partly covered by tests with other names; until the hazard log says so,
they count as unverified.

## 11. Residual risk

- **Level 5**: none.
- **Level 4**: HZ-071 (full export misread on a change of system) is recorded at Catastrophic / Low /
  4 until the CSO accepts that its controls bring the likelihood to Very low (H-119). **This blocks
  a production release** under the plan, section 3.3, unless the CSO accepts it or a further control
  is added. The import round-trip test is planned with PLAT-014 (Phase 2).
- **Level 3 in the hazard log** (13, each needing the CSO's recorded acceptance): HZ-002, HZ-003,
  HZ-005, HZ-008, HZ-013, HZ-014, HZ-023, HZ-027, HZ-040, HZ-061, HZ-071 (once accepted at 3),
  HZ-073 and HZ-112 (until its mobile control is built).
- **Level 2 and 1**: the remaining 32 hazards (31 at level 2, and HZ-080 at level 1), subject to the
  CSO's review of each rating (H-21).

**The level-3 hazards for a web-only release.** The log rates each hazard for the whole product. This
release is web only and has no medicines, so the table below says whether each level-3 hazard
applies, proposes a rating for a web-only deployment, and gives the reason the level cannot be
reduced further. The web-only ratings are engineering proposals; the hazard log is unchanged until
the CSO decides.

| Hazard | Applies to this release (web only) | Web-only target residual (proposal) | Why it cannot be reduced further |
| --- | --- | --- | --- |
| HZ-002 Stale offline data | Partly: the web holds no offline copy, but a page left open or a printed pack can be out of date | Major / Very low / 2 | The log's level 3 rests on phones that cannot receive changes. On the web the header is read again on every tab move, every two minutes and on return, with "Checked at" and "Check again" (`care-record.spec.ts`) |
| HZ-003 Missed medication | Partly: no eMAR; the paper MAR is the record. Medicines support written outside the medicines domain still makes rounds (H-151) | Major / Low / 3 (re-rated with the eMAR) | Giving a medicine is a human act; with the paper MAR the remaining risk is staff reading Harbour's round as the medicines list, which H-151 decides |
| HZ-005 Transcription error | Partly: the pre-admission medicines list prints on the transfer pack, headed "check against the MAR" (H-82) | Major / Low / 3 | A person reads and types a source document until pharmacy data is imported; dose-range checking would cross the medical-device boundary |
| HZ-008 Alert fatigue | Yes | Major / Low / 3 | A human-factors hazard: design reduces volume but cannot remove it, and fewer alerts would raise HZ-013 and HZ-014 |
| HZ-013 Notification missed or late | Yes | Major / Low / 3 | Harbour cannot make anyone record an incident, and submission is a regulated human decision by a named role |
| HZ-014 Deterioration trigger not acted on | Yes | Major / Low / 3 | Acting on a score is a clinical decision; automating it would cross the medical-device boundary |
| HZ-023 Transfer pack incomplete | Yes | Major / Low / 3 | Blocking a transfer until the record is complete would cause greater harm; completeness depends on what the provider recorded |
| HZ-027 Head injury after a fall | Yes | Major / Low / 3 | Recognising deterioration and seeking advice are clinical actions by staff; the observation figures are unconfirmed (H-66) |
| HZ-040 Held entries deleted | No: held entries exist only on phones | Not rated for this release | Not applicable while mobile is excluded |
| HZ-061 Family reassured by a misleading update | Yes | Considerable / Medium / 3 | No word list can recognise every reassuring phrase, and a manager may confirm wording the record does not support; held at the initial rating until the CSO reviews the lists (H-110) |
| HZ-071 Export misread | Yes | Catastrophic / Very low / 3 (4 until H-119) | Severity stays Catastrophic because one bad import reaches every person; the receiving system's import is outside Harbour's control |
| HZ-073 Safety work hidden by scope | Yes | Major / Low / 3 | The provider designs its role bundles; software cannot fix a bundle that leaves no one at a home able to act |
| HZ-112 Second factor | Yes, on the web | Major / Very low / 2, once the deploy plan in H-358 is followed | The log keeps level 3 only until the mobile app understands the refusal code; on the web a refused person is sent straight to sign in with their factor (`problems.test.ts`) |

For a web-only release the level-3 set is therefore ten hazards (HZ-003, HZ-005, HZ-008, HZ-013,
HZ-014, HZ-023, HZ-027, HZ-061, HZ-071 and HZ-073), with HZ-002 and HZ-112 proposed at level 2 and
HZ-040 not applicable. Whether the medicines and mobile hazards are "not applicable to a web-only
release" is the CSO's decision (section 13).

## 12. Open human actions and outstanding risks

Every hazard is open. The build never waits for these; each blocks go-live for the feature it names.

**Count.** [human-actions.md](../../plans/human-actions.md) holds 141 open actions owned or co-owned
by the CSO, besides H-381 (this report). 35 of them unblock only the mobile app (H-22, H-26, H-67,
H-83, H-124, H-126 to H-129, H-134, H-141 to H-149, H-156 to H-158, H-164, H-165, H-300 to H-310).
**106 are not mobile-only.** Of those, 105 block a live tenant using the web feature they name;
H-353 blocks only turning on the browser idle timeout, which is off. Grouped by what they block:

| What they block | Count | Actions |
| --- | --- | --- |
| The first real tenant (including "before the first real tenant" and its go-live) | 43 | H-69, H-70, H-82, H-84 to H-89, H-91 to H-94, H-122, H-130 to H-133, H-135 to H-138, H-150 to H-155, H-261 to H-270, H-350, H-351, H-354, H-358, H-359 |
| Any real tenant | 13 | H-24, H-168, H-250 to H-260 |
| Downtime packs for a live tenant | 11 | H-100 to H-102, H-200, H-201, H-209 to H-214 |
| Outages and back-entry for a live tenant | 9 | H-202 to H-208, H-215, H-216 |
| Evidence packs (and letters) for a live tenant | 3 | H-95, H-221, H-222 |
| The safety case itself | 7 | H-21, H-23, H-61, H-90, H-108, H-119, H-224 |
| Food and fluid charts for a live tenant | 4 | H-74, H-160, H-166, H-167 |
| Validated tools for a live tenant | 2 | H-73, H-163 |
| The people release (transfer pack, admission) | 2 | H-27, H-28 |
| Data scope per permission | 2 | H-169, H-170 |
| The family feed for a real tenant | 3 | H-110, H-370, H-371 |
| Other named features: care planning (H-60), post-fall tasks (H-66), the web care record (H-71), clock changes (H-72), body maps (H-162), candour letters (H-103), the idle timeout (H-353) | 7 | As listed |
| **Total** | **106** | |

Clinical actions among them that bear directly on the safety argument:

- H-251: a renewed DoLS authorisation reads "expired" from the API, and nothing checks for a gap
  between authorisations (HZ-020).
- H-66: the post-fall observation defaults, not from a care home source (HZ-027, level 3).
- H-27: the six safety-critical transfer pack sections and HZ-023's level-3 risk.
- H-74, H-160, H-166, H-167: IDDSI levels on food and drink entries, which prescribed level an entry
  is compared with, and refused drinks beside the fluid total (HZ-014, HZ-016).
- H-73, H-127, H-163: validated-tool wording and the escalation policy lookup (A4.7).
- H-224: whether HZ-080 is in DCB0129 scope.

**Actions not owned by the CSO that also block go-live**: H-20 (appoint the CSO), H-25 (regulatory
opinion and tool licences), H-04 (the first AWS account), and the per-tenant onboarding actions.

**Outstanding risks and known defects with clinical relevance**:

- **Mobile exclusion enforced** (section 2.4; H-381, applied 31/10/2026): Care mode is off for every
  organisation until it switches the flag on, and no store build runs while the exclusion stands. A
  tenant switching the flag on before a safety case covers the app is the remaining deployer risk.
- **HZ-071 at level 4** blocks a production release (section 11).
- **Web screens are missing** for 22 Phase 1 rows whose rules are API-only (people lifecycle,
  documents, tasks and retention, candour, medical examiner, investigations, evidence pack composing,
  statement of purpose). Staff cannot see review tasks on screen (HZ-003, HZ-004, HZ-006).
- **No user guides exist**, so the "Training and user documentation" controls that every hazard
  relies on in part are not yet in place.
- **Device modes are not recorded**, so the onboarding item for shared and kiosk devices stays open
  and blocks go-live by design (HZ-001, HZ-072).
- **The DPIA template has no Phase 1 risks** (a data-protection gap that overlaps HZ-050, HZ-051 and
  HZ-070).
- **Unconfirmed figures** in the rate table (section 7).

## 13. Decisions for the CSO

The CSO's decisions on this report, in the order they unblock each other:

1. **Prerequisites for signing (H-381)**: approve the plan and review every rating (H-21), hold the
   SWIFT workshop and decide the candidate hazards (H-23), sign v0.0 (H-24).
2. **Level-3 acceptance**: accept or reject each level-3 residual risk in section 11, including
   whether HZ-003 and HZ-005 (medicines) and HZ-002, HZ-040 and HZ-112 (mobile-dependent) are rated
   for a web-only release as proposed, or "not applicable to a web-only release".
3. **HZ-071**: accept that its controls bring the likelihood to Very low (residual 3), or ask for
   more; until then it is at level 4 and blocks production (H-119).
4. **Validated tools**:
   - whether the tools may go live while the full published banding table is not on screen and
     templates are not locked (boundary rule 2; HZ-012);
   - the "tell the nurse in charge" wording on every band, NEWS2 0 included (H-73);
   - the RCP ward wording in homes without nurses, on the web as well as the phone (H-127);
   - the escalation policy lookup order (H-163);
   - the CSO's check of each tool against its source, and the NEWS2 vectors (H-129);
   - with Brian, the regulatory opinion and licences, including MUST, which is on by default (H-25).
5. **Mobile exclusion**: a control is needed, as recommended for H-381 and now built (section 2.4):
   the tenant setting refusing Care mode sign-in, sync and upload, off by default, and no store
   build while the exclusion stands. The review at the testing phase confirms it.
6. **Clinical defaults and states**: the post-fall observation defaults (H-66); a renewed DoLS
   authorisation reading as expired (H-251); and a triage of the 106 open non-mobile actions in
   section 12 into must-close-before-go-live and may-follow.
7. **Record history labelling**: once the history tab journey merges, confirm how a record's history
   labels earlier versions, corrections and what a review changed (HZ-024, HZ-017).
8. **Scope**: whether HZ-080 (statement of purpose) belongs in DCB0129 scope (H-224).

## 14. Deployer information

No tenant may use this release for real people until this report is signed. When it is, the tenant's
DCB0160 assessment ([template](../dcb0160-deployment-template.md)) must cover these deployer controls,
taken from the hazard log:

- Use the **web app only** for care in this release; the mobile app is not covered and must not be
  installed on staff devices (section 2.4).
- Keep the **paper MAR** and the fire file current until the eMAR and PEEPs are in Harbour (HZ-021).
  Do not take Harbour's round as the medicines list (H-151).
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
  deterioration and deaths (HZ-060, HZ-061), and sharing decisions reviewed at each care plan review
  (HZ-022).
- **Evidence packs**: the quality lead reviews the redaction preview before a second person releases
  (HZ-050). **Letters**: starter wording reviewed; candour letters signed off by the Registered
  Manager (HZ-051).
- **Exports**: downloaded only to a managed, encrypted device and deleted after use; a receiving
  provider reconciles row counts and checks essentials person by person (HZ-070, HZ-071).
- **Sessions**: a carer is signed out mid-shift only for a lost device, departure, suspension or
  suspected misuse (HZ-110).
- **Configuration**: review the rate-table defaults in section 7 and confirm or change each before
  go-live.
- **Access review** at intervals set by the provider (HZ-011); managers review the monthly alert
  report (HZ-008).

## 15. Known limitations

- Every rating is an engineering proposal; no clinician has reviewed any of them. The reviews so far
  are by an AI agent (section 3).
- No SWIFT workshop has been held.
- The mobile app is out of scope and its exclusion is not enforced.
- Medicines are not built; HZ-003 to HZ-005 rest on paper processes.
- Waterlow and Braden are off for every tenant until H-25 closes; MUST is on while its licence terms
  are still open.
- Training and user documentation controls do not exist yet (no user guides).
- The hazard log is Markdown; the NHS assurance-format export arrives in Phase 5.
- This report is drafted against `main` before tagging; the tag, commit and CI evidence are filled at
  tagging, and any change between this draft and the tag needs a delta.

## 16. Conclusions and recommendations

**Conclusions.**

1. The engineering evidence is substantial: every hazard has at least one automated test, 508 of 592
   verification rows pass in CI, and the validated tools, tenant isolation, notification clocks and
   disclosure controls are each tested at several layers.
2. The evidence does not yet support use with real people. No clinician has reviewed any rating;
   HZ-071 sits at level 4; 106 open CSO actions block web features for a live tenant; key controls
   (the on-screen banding table, locked templates, server-received time checks, escalation until
   acknowledged, the web photo) are unbuilt or untested; there are no user guides.
3. The mobile app cannot be covered by this report, and nothing yet stops it being used.

**Recommendations.**

1. Appoint the CSO (H-20), then complete the decisions in section 13 before any go-live date is set.
2. Add a control that keeps Care mode off for a tenant until a safety case covers it, and do not tag a
   release candidate while the Expo token is set.
3. Build the HZ-012 banding table and template lock, or have the CSO accept going live without them.
4. Close the planned Phase 1 verification rows in Appendix A that apply to the web, starting with
   HZ-010, HZ-013, HZ-014 and the web photo test, and give the NG249 "no score" test its hazard ID.
5. Write the role user guides so the training controls exist.
6. At tagging, refresh sections 6, 10 and 12 against the tagged commit, with the CI run and the
   hazard-ID test report.

## 17. Sign-off

**Clinical Safety Officer approval: pending.** Harbour engineering cannot sign this report. The CSO's
review and signature, and top management's acknowledgement, are logged as H-381 in
[docs/plans/human-actions.md](../../plans/human-actions.md). The CSO records the decisions in section
13 and the acceptance of each level-3 residual risk (section 11) here.

| Role | Name | Registration | Date | Signature |
| --- | --- | --- | --- | --- |
| Clinical Safety Officer | `[CSO name - human action]` | `[professional body and number - human action]` | `[date]` | `[signature - human action]` |
| Top management | `[Brian, Thapsus director - human action]` | Not applicable | `[date]` | `[signature - human action]` |

| Level-3 residual risk | Web-only proposal | CSO decision |
| --- | --- | --- |
| HZ-002 | Level 2 | `[accept, reject or not applicable - human action]` |
| HZ-003 | Level 3 | `[accept, reject or not applicable - human action]` |
| HZ-005 | Level 3 | `[accept, reject or not applicable - human action]` |
| HZ-008 | Level 3 | `[accept or reject - human action]` |
| HZ-013 | Level 3 | `[accept or reject - human action]` |
| HZ-014 | Level 3 | `[accept or reject - human action]` |
| HZ-023 | Level 3 | `[accept or reject - human action]` |
| HZ-027 | Level 3 | `[accept or reject - human action]` |
| HZ-040 | Not applicable | `[agree or rate - human action]` |
| HZ-061 | Level 3 | `[accept or reject - human action]` |
| HZ-071 | Level 3, recorded at 4 until accepted | `[accept or reject - human action]` |
| HZ-073 | Level 3 | `[accept or reject - human action]` |
| HZ-112 | Level 2 | `[accept, reject or not applicable - human action]` |

## Appendix A. Verification rows not yet passing

Taken from the hazard log at `aae5ab5`, one row per Verification row whose status is not "Passing"
(84 rows). Test titles are shortened to their first named test.

| Hazard | Test | Status |
| --- | --- | --- |
| HZ-001 | `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml`: the header shows with no signal | Written; not run in CI |
| HZ-001 | `packages/ui-native`: `hazard HZ-001 person header renders photo, full name, preferred name, date of birth and room` | Planned, Phase 1 |
| HZ-001 | `packages/ui-native`: `hazard HZ-001 person header shows a labelled placeholder when no photo is on record` | Planned, Phase 1 |
| HZ-001 | `packages/ui`: `hazard HZ-001 web person header renders photo, name, date of birth and room` | Planned, Phase 1 |
| HZ-001 | `packages/domain` (people): `hazard HZ-001 flags similar names among active people at the same location` | Planned, Phase 1 |
| HZ-001 | `packages/domain` (people): `hazard HZ-001 detects a probable duplicate person on create and import` | Planned, Phase 1 |
| HZ-001 | `apps/api`: `hazard HZ-001 rejects a write whose person is outside the tenant or the user's scope` | Planned, Phase 1 |
| HZ-001 | `apps/mobile` Maestro: `hazard-HZ-001-no-auto-advance.yaml` | Planned, Phase 1 |
| HZ-001 | `packages/domain` (medicines): `hazard HZ-001 refuses an administration without wristband scan or photo confirmation` | Planned, Phase 2 |
| HZ-002 | `packages/sync`: `hazard HZ-002 banner state is stale when the last successful sync exceeds the threshold` | Planned, Phase 1 |
| HZ-002 | `packages/ui-native`: `hazard HZ-002 allergy, medicines and resuscitation panels show when data was last confirmed` | Planned, Phase 1 |
| HZ-002 | `apps/mobile` Maestro: `hazard-HZ-002-offline-banner.yaml` | Planned, Phase 1 |
| HZ-002 | `packages/sync`: `hazard HZ-002 priority stream delivers allergy and medicine-stopped changes before routine data` | Planned, Phase 2 |
| HZ-003 | `packages/domain` (medicines): `hazard HZ-003 expands every supported frequency into the correct doses across a 28-day cycle` | Planned, Phase 2 |
| HZ-003 | `packages/domain` (medicines): `hazard HZ-003 a dose with no recorded outcome stays outstanding after its window` | Planned, Phase 2 |
| HZ-003 | `packages/domain` (medicines): `hazard HZ-003 time-critical medicines escalate at the earlier threshold` | Planned, Phase 2 |
| HZ-003 | `packages/domain` (medicines): `hazard HZ-003 a round cannot close with outstanding doses without a reason` | Planned, Phase 2 |
| HZ-003 | `packages/domain` (medicines): `hazard HZ-003 refuses an administration without person, dose and outcome` | Planned, Phase 2 |
| HZ-003 | `apps/api`: `hazard HZ-003 an overdue time-critical dose escalates to the nurse in charge` | Planned, Phase 2 |
| HZ-003 | `apps/mobile` Maestro: `hazard-HZ-003-offline-round.yaml` | Planned, Phase 2 |
| HZ-004 | `packages/domain` (medicines): `hazard HZ-004 blocks a second administration within the minimum interval unless an override reason is given` | Planned, Phase 2 |
| HZ-004 | `packages/domain` (medicines): `hazard HZ-004 enforces the PRN maximum in 24 hours` | Planned, Phase 2 |
| HZ-004 | `apps/api`: `hazard HZ-004 replaying the same client UUID does not create a second administration` | Planned, Phase 2 |
| HZ-004 | `apps/api`: `hazard HZ-004 two devices recording the same scheduled dose create a conflict review task` | Planned, Phase 2 |
| HZ-004 | `packages/db`: `hazard HZ-004 medication_administration has no UPDATE or DELETE grant` | Planned, Phase 2 |
| HZ-004 | `apps/mobile` Maestro: `hazard-HZ-004-offline-conflict.yaml` | Planned, Phase 2 |
| HZ-005 | `packages/domain` (medicines): `hazard HZ-005 rejects a dose whose unit is not permitted for the dm+d product` | Planned, Phase 2 |
| HZ-005 | `packages/domain` (medicines): `hazard HZ-005 formats doses with a leading zero, no trailing zero and micrograms in full` | Planned, Phase 2 |
| HZ-005 | `packages/domain` (medicines): `hazard HZ-005 a new or changed MAR entry stays not yet checked until a second competent user verifies it` | Planned, Phase 2 |
| HZ-005 | `packages/domain` (medicines): `hazard HZ-005 the checker must be a different user from the transcriber` | Planned, Phase 2 |
| HZ-005 | `packages/domain` (medicines): `hazard HZ-005 non-daily schedules show the day on every MAR row` | Planned, Phase 2 |
| HZ-005 | `apps/api`: `hazard HZ-005 imported medicines are created as not yet checked` | Planned, Phase 2 |
| HZ-006 | `packages/sync`: `hazard HZ-006 exposes queued change count and last successful sync time to the banner` | Planned, Phase 1 |
| HZ-006 | `apps/api`: `hazard HZ-006 a stale expected_version creates a review task, never a silent overwrite` | Planned, Phase 1 |
| HZ-006 | `apps/api`: `hazard HZ-006 a device on an active shift with no recent sync appears on the manager dashboard` | Planned, Phase 1 |
| HZ-006 | `apps/mobile` Maestro: `hazard-HZ-006-signout-with-queue.yaml` | Planned, Phase 1 |
| HZ-006 | `apps/mobile` Maestro: `hazard-HZ-006-sync-recovery.yaml` | Planned, Phase 1 |
| HZ-006 | `apps/mobile` Maestro: `hazard-HZ-006-held-entry-kept.yaml` | Planned, Phase 1 slice 10 |
| HZ-006 | `apps/mobile/.maestro/hazard-HZ-006-offline-note-and-vitals.yaml`: a note and vital signs written offline wait, survive closing the app, then upload | Written; not run in CI |
| HZ-007 | `packages/ui-native`: `hazard HZ-007 header shows allergy status not recorded when no allergy record exists` | Planned, Phase 1 |
| HZ-007 | `packages/ui`: `hazard HZ-007 web header shows allergy status not recorded when no allergy record exists` | Planned, Phase 1 |
| HZ-007 | `packages/domain` (people): `hazard HZ-007 no known allergies can only be recorded positively with author and time` | Planned, Phase 1 |
| HZ-007 | `packages/sync`: `hazard HZ-007 allergy rows for assigned people survive eviction` | Planned, Phase 1 |
| HZ-007 | `packages/ui-native`: `hazard HZ-007 header shows the count and most severe reactions first when allergies exceed the space` | Planned, Phase 1 |
| HZ-007 | `apps/web` Playwright: `hazard HZ-007 printed MAR includes the allergy section` | Planned, Phase 2 |
| HZ-007 | `packages/domain` (medicines): `hazard HZ-007 administration view includes the person's recorded allergies` | Planned, Phase 2 |
| HZ-008 | `packages/domain` (platform): `hazard HZ-008 every notification type declares a tier and an action` | Planned, Phase 1 |
| HZ-008 | `packages/domain` (platform): `hazard HZ-008 repeated triggers for the same condition update one alert` | Planned, Phase 1 |
| HZ-008 | `packages/domain` (platform): `hazard HZ-008 information-tier notifications never send push` | Planned, Phase 1 |
| HZ-008 | `apps/api`: `hazard HZ-008 a tenant cannot disable escalation of time-critical medicines` | Planned, Phase 2 |
| HZ-008 | `apps/api`: `hazard HZ-008 alert volume and override metrics are reported per user and type` | Planned, Phase 2 |
| HZ-009 | `packages/domain` (medicines): `hazard HZ-009 a 01:30 dose on a spring-forward day moves to 02:30 BST and is flagged` | Planned, Phase 2 |
| HZ-009 | `packages/domain` (medicines): `hazard HZ-009 a 01:30 dose on a clocks-back day occurs once` | Planned, Phase 2 |
| HZ-009 | `packages/domain` (medicines): `hazard HZ-009 a 4-hour minimum interval spanning a clock change is measured in elapsed time` | Planned, Phase 2 |
| HZ-009 | `packages/domain` (medicines): `hazard HZ-009 an 08:00 daily dose stays at 08:00 local time either side of each transition` | Planned, Phase 2 |
| HZ-009 | `packages/domain` (platform): `hazard HZ-009 date of birth round-trips unchanged under every test time zone` | Planned, Phase 1 |
| HZ-009 | `apps/mobile` Maestro: `hazard-HZ-009-device-zone.yaml` | Planned, Phase 1 |
| HZ-010 | `packages/db`: append-only event columns keep device time, device offset and server-received time | Built in Phase 0 |
| HZ-010 | `apps/api`: `hazard HZ-010 every uploaded event is stamped with server-received time` | Planned, Phase 1 |
| HZ-010 | `packages/sync`: `hazard HZ-010 drift over 5 minutes between device and server is flagged` | Planned, Phase 1 |
| HZ-010 | `apps/api`: `hazard HZ-010 a device time later than server-received time creates a review flag` | Planned, Phase 1 |
| HZ-010 | `packages/domain` (care): `hazard HZ-010 a note written more than 2 hours after the event carries the late-entry flag` | Planned, Phase 1 |
| HZ-010 | `packages/domain` (medicines): `hazard HZ-010 the minimum-interval check uses the drift-corrected clock` | Planned, Phase 2 |
| HZ-011 | `apps/api`: `hazard HZ-011 agency access expires at shift end plus 2 hours` | Planned, Phase 2 |
| HZ-012 | `packages/domain` (platform): `hazard HZ-012 tenants cannot edit locked validated templates` | Planned, Phase 1 |
| HZ-012 | `apps/web` Playwright: `hazard HZ-012 the score screen shows the full published banding table beside the band` | Planned, Phase 1 |
| HZ-013 | `packages/domain` (safety): `hazard HZ-013 an unacted clock escalates to the Nominated Individual before breach` | Planned, Phase 1 |
| HZ-014 | `apps/api`: `hazard HZ-014 an urgent assessment alert escalates until acknowledged` | Planned, Phase 1 |
| HZ-021 | `apps/mobile` Maestro: `hazard-HZ-021-kiosk-downtime-pack.yaml` | Planned, Phase 1 |
| HZ-022 | `packages/sync`: `hazard HZ-022 family streams carry only shared sections` | Planned, Phase 4 |
| HZ-023 | `apps/mobile` Maestro: `hazard-HZ-023-offline-transfer-pack.yaml` | Planned, Phase 1 |
| HZ-024 | `apps/mobile`: `hazard HZ-024 the phone's round says when a task comes from an earlier plan` | Planned, Phase 1 slice 10 part 2 (screens) |
| HZ-027 | Maestro: `hazard-HZ-027-post-fall-observations.yaml` | Planned, Phase 1 |
| HZ-028 | `packages/sync`: `hazard HZ-028 present body-map marks stay on the device beyond the window` | Planned, Phase 1 (needs the server-maintained flag) |
| HZ-040 | Stale-device check (the table is built; the check is not, H-141) | Planned, Phase 1 |
| HZ-051 | `apps/api`: `hazard HZ-051 a letter's values print as text in the PDF` | Planned |
| HZ-051 | `apps/api`: `hazard HZ-051 a letter cannot be made with another person's details` | Covered by `letters.test.ts` |
| HZ-060 | `apps/api`: `hazard HZ-060 the notification worker sends the approved template only` | Planned, Phase 1 (slice 12 API step) |
| HZ-071 | `apps/api`: `hazard HZ-071 an export round-trips through the import wizard with matching counts` | Planned, Phase 2 (with PLAT-014) |
| HZ-072 | `apps/api`: `hazard HZ-072 a sample incident drafts no statutory notification` | Planned, Phase 1 (with sample records beyond people) |
| HZ-072 | Maestro: `hazard-HZ-072-sample-banner.yaml` | Planned, Phase 1 (mobile) |
| HZ-092 | Playwright: each entry opened from the reconciliation screen, with the person, kind and time | Planned (with an API change) |
| HZ-111 | Playwright: a form half-filled, the warning shown before expiry, "Stay signed in" keeps the session | Planned |
| HZ-112 | Mobile: a 403 `mfa_verification_required` on the sync token is treated as a session code | Planned |
