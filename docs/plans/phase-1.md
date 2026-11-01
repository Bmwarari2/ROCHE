# Phase 1: Residential MVP

## Summary

Phase 1 turns the foundations into a care record a residential or nursing home can run a day on:
the person's journey from pre-admission to discharge or death; the personalised care and support
plan with risk assessments and the validated tools; daily notes and the core charts; body maps;
tasks, rounds and handover; consent, capacity, best interests and the DoLS register with the 2026
legal-change switch; incidents with the full classifier, deadline clocks and the candour workflow;
the nightly downtime pack and the inspector evidence pack; the Expo app's Care mode working
offline; and a read-only family feed released only under a recorded sharing decision. Section 19
sets the gate; the 54 Phase 1 rows of the [feature register](../specs/feature-register.md) set the
scope.

## Decisions taken for this phase

Defaults from the Appendix already cover residential first (ADR-0004), the 7-day offline window and
kiosk lock (ADR-0011) and the duty-of-candour default (ADR-0021). New decisions are recorded as ADRs
when the slice that needs them starts:

- PDF rendering for the downtime pack, hospital transfer pack, inspector pack and history export
  (candidates: Typst, Apache-2.0, or pdf-lib, MIT), rendered on the server, watermarked.
- Document storage port (local filesystem in development and tests; in production Cloud Storage
  with CMEK by [ADR-0098](../decisions/0098-production-on-google-cloud.md), built first as S3 with SSE-KMS), with signed uploads and an
  antivirus hook.
- Offline write model for append-only care events (client-generated UUIDv7, device and server
  times, idempotent upload, supersedes for corrections) and the conflict review for mutable rows.

## Work plan (pull requests in order)

Each slice follows the section 19 order (schema and domain rules first, then API, web, mobile,
integrations, documentation) and lands as its own pull request stacked on the previous one.

| # | Slice | Register rows | Content |
| --- | --- | --- | --- |
| 1 | Plan and specs | - | This plan; `care.md` (capacity and consent: [section 4 rule 9](../specs/care.md#4-rules-that-are-easy-to-get-wrong)), `safety.md` specs; `people.md` lifecycle; new hazards; data-standards and records-of-processing rows for every new field |
| 2 | Platform engines | PLAT-009, PLAT-011, PLAT-012 | Task and workflow engine (owner, due, recurrence, evidence, states, approvals, SLA escalation); versioned document store with categories, retention class and typed-name e-signature; retention engine core (soft delete, legal hold, destruction certificate) |
| 3 | Validated tools and chart rules (domain) | CARE-003, CARE-006, CARE-007, CARE-010 | Waterlow, Braden, MUST, NEWS2 and the NG249 falls question as coded calculators with table-driven tests against the published instruments; fluid targets and running totals, IDDSI levels, repositioning intervals, Bristol scale, weight frequency, late-entry rule |
| 4 | Care record schema and API | CARE-001, CARE-002, CARE-009, CARE-010, CARE-012, CARE-014, CARE-015 | `care_plan`, `care_plan_item`, `risk_assessment`, `assessment`, append-only `care_note` and `observation`, `body_map_mark`, `activity_record`, `visit_log`, `advance_care_record`; RLS and isolation tests; history and audit |
| 5 | Tasks, rounds and handover | CARE-013, COMMS-006 | Care plan actions generate shift tasks; round view; overdue escalation; handover compiled from the shift's notes, incidents, tasks and alerts; acknowledgement |
| 6 | Consent, capacity and DoLS | CARE-021, CARE-022 | Consent records; two-stage capacity assessment; best-interests checklist; DoLS register with expiry clocks, CQC notification draft and the review-of-existing-authorisations workflow behind a tenant setting |
| 7 | Incidents and notifications | SAFE-001 to SAFE-005, SAFE-007 to SAFE-010 | Capture with people, witnesses and body map; classifier (CQC Reg 16 and 18, RIDDOR with the work-activity test, s.42 safeguarding, candour, LeDeR, UKHSA outbreak, medical examiner pack, missing person); deadline clocks; drafts signed with step-up; candour log; investigations, actions and lessons; falls and pressure-ulcer protocols |
| 8 | People lifecycle (residential) | PEOP-001 to PEOP-003, PEOP-005, PEOP-007 to PEOP-010, PEOP-013 | Pre-admission assessment and decision; admission with room and move history, property inventory and welcome checklist; About Me authoring; review scheduler; hospital transfer pack; discharge, transfer and death workflows with read-only archive state; sharing rules; break-glass weekly report (PLAT-006) |
| 9 | Web UI | the rows above | Person record tabs (overview, care plan, assessments, notes, charts, body map, MCA, incidents, history), round and handover views, incident and notification screens, role dashboards (INSI-001), branding (PLAT-002) |
| 10 | Offline Care mode | MOB-002, MOB-005, MOB-006, MOB-010 | Sync streams for the new tables scoped to assignments; local writes for notes, charts, body-map marks, tasks and incidents; upload with idempotency; conflict review; kiosk mode; remote wipe, root and jailbreak warning, screenshot blocking |
| 11 | Packs and governance | OPS-028, QUAL-003, QUAL-009, COMMS-007 | Nightly downtime pack per location with back-entry workflow; inspector evidence pack (watermarked PDF bundle, time-limited link); statement of purpose with change tracking; letter and email templates with approval |
| 12 | Family feed and comms | COMMS-001, INTG-011 | Family app mode and web feed of updates and consented care plan sections, closed until a sharing decision exists; email through the email port (built on SES; an SMTP adapter under ADR-0098), SMS port, Expo push registration |
| 13 | Platform completions | PLAT-013, PLAT-015, PLAT-018, PLAT-023 | Permission-aware search; free full tenant export; in-app help and onboarding checklist; DPIA prefill and sign-off |
| 14 | Store readiness and gate | MOB-011, MOB-012 | Privacy manifest and data safety, account deletion flow, listing copy; Maestro offline journey; safety case v0.1; user guides per role; gate record |

## Hazards expected in this phase

New hazards are added with the `hazard` skill as each slice starts (candidates): late or backdated
entries mistaken for contemporaneous ones; a NEWS2 or MUST trigger that does not reach the nurse in
charge; DoLS authorisation expiry missed; handover omitting a safety-critical item; body-map
laterality (left and right) recorded wrongly; IDDSI texture level shown wrongly (choking); family
feed showing a section without a sharing decision; downtime pack out of date when IT fails.
HZ-001, HZ-002, HZ-006, HZ-007, HZ-008, HZ-010, HZ-012 and HZ-013 gain their Phase 1 controls and
tests.

## Gate (section 19): verified by Claude Code

| Gate item | Evidence |
| --- | --- |
| Maestro offline journey: sign in, write notes and charts offline, sync, conflict review, on an iOS simulator and an Android emulator | `.github/workflows/mobile.yml` |
| Inspector pack export renders | Snapshot and PDF render tests |
| WCAG scans clean | Playwright and axe journeys for every new screen; Storybook axe |
| Every hazard-log entry has a test | `grep -rn "HZ-0" apps packages` against the log |
| Clinical safety case v0.1 drafted | `docs/clinical-safety/safety-case/` |

## Human follow-ups (logged, never blocking)

A design-partner home runs a day on two phones and a tablet (H-56); the CSO reviews safety case v0.1
(H-21, H-24); licence terms and the authoritative source for Waterlow, and the regulatory opinion on
the validated tools (H-25).
