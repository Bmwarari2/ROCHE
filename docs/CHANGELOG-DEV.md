# Development log

One entry per working session (section 20 rule 9): what changed, what is next, human actions
logged, test status.

## 2026-10-11: Phase 0 foundations

**What changed**

- Master prompt saved; Part C moved to `docs/02-SOURCES.md`; constraints digest; CLAUDE.md; Claude
  Code settings, commit guard hook, five skills and three reviewer agents.
- Monorepo (pnpm, Turborepo, TypeScript 6, Biome, Vitest), CI workflows (lint, commitlint, licence
  allowlist, docs and medicines gates, link check, typecheck, tests on Postgres 17, coverage,
  OpenAPI drift and breaking changes, Storybook, Playwright with axe, gitleaks, Trivy, SBOM, audit,
  CodeQL, Terraform, Maestro and EAS), CODEOWNERS, templates, Renovate, Changesets, husky.
- Database: tenancy with the group layer, people, roles and grants, audit with a hash chain,
  versioning, outbox, notifications and deliveries, forms, rate and retention tables, integrations,
  operator tables; forced RLS everywhere; per-purpose roles; demo seed.
- Domain rules: permissions and 21 built-in roles, access and scope resolution, step-up,
  separation of duties, branding contrast, rates, retention, forms, escalation and quiet hours,
  NHS numbers, UK time and clock drift, integration ports.
- API: Better Auth (passkeys, TOTP, bearer), tenant context, MFA gate, step-up, people with audit,
  break-glass, notifications, audit with chain verification, forms, rates, sync tokens and uploads,
  integrations and quarantine, support access, operator console, worker jobs, migrate task,
  container image, OpenAPI 3.1 and the generated typed client.
- Design system with 15 components and Storybook; mobile skeleton with encrypted offline store;
  sync streams with isolation tests; i18n catalogues; Terraform for three environments; local stack.
- ADR-0001 to ADR-0029; hazard log HZ-001 to HZ-013 with Phase 0 tests linked; compliance
  checklists and templates; runbooks; feature register (233 rows); rates (169) and retention.

- Web shell (Next.js 16): sign-in with password then TOTP or a passkey, organisation and location
  choice, home, people and the point-of-care header with break-glass, notifications, sign-in and
  security settings; Playwright journeys with axe; container image.
- Security hardening found while integrating the web shell (ADR-0030): session tokens only reach
  the mobile app; devices listed and signed out by id (`/v1/me/sessions`); per-request nonce CSP;
  the browser reaches only `/api/auth`, passed through at run time so one image serves every
  environment; sign-in throttling per client address through trusted proxies; production refuses
  to start without every database URL; the operator database URL is now passed by Terraform.
- Dependencies: Next.js's optional `sharp` (LGPL libvips) is not installed; React types resolve per
  app (web 19.3, Expo 19.2).

**Next**: CI on the Phase 0 pull request, then Phase 1 (see STATUS.md).

**Human actions logged**: H-01 to H-57 in `docs/plans/human-actions.md`.

**Tests**: all suites pass locally (see STATUS.md totals). Not run here: Maestro on devices, a
Terraform plan against AWS, Docker image builds (no daemon).

## 2026-10-11: Phase 1 slice 3, validated tools and chart rules (domain)

**What changed**

- `packages/domain/src/care/`: NEWS2 (RCP 2017, charts 1, 2 and 4), MUST (BAPEN, 2011 review),
  Waterlow (2005 card) and Braden (1988 form) as pure calculators that return the tool version,
  score, band, workings and triggers, and a typed error with no total for missing or impossible
  input; the NG249 falls pathway (triggers only, never a score); late and future entries; fluid
  balance days in UK time (23- and 25-hour days); IDDSI levels and the prescribed-level check;
  repositioning intervals; Bristol scale and the no-movement prompt; weight frequency; body map
  regions, side agreement, pressure ulcer categories and the incident and safeguarding prompts.
- Every tenant default comes from the rate table through `resolveCareRates`; tests read the real
  `docs/specs/rates.md`. New row `bowel.no_movement_prompt_days` (3, tenant default, to verify).
- Hazard log: HZ-012, HZ-014, HZ-016, HZ-017 and HZ-019 domain tests passing (HZ-009 care tests
  added); register rows CARE-003, CARE-006, CARE-007, CARE-010 and CARE-012 now `partial`;
  medical-device boundary notes the implementation and the readings taken where a form is ambiguous.

- Corrections after review: MUST and Waterlow band the exact BMI (rounded only for display, so
  18.49 scores 2 on MUST); the NG249 falls pathway is setting-aware in NICE's words (1.1.7 in
  residential care, 1.1.3 and 1.1.4 in the community, 1.1.6 for no fall); Braden uses the
  publisher's band wording; the Waterlow readings are tabled in the medical-device boundary.

**Next**: slice 4 (care record schema and API) stores these results and decides whether a late entry
is measured from device or server time; Waterlow and Braden stay off for real tenants until H-25 is
closed.

**Human actions logged**: none new; H-25 (licence terms and regulatory opinion) covers Waterlow and
Braden. The CSO should review the readings listed in the medical-device boundary (H-21).

**Tests**: `packages/domain` 687 passing, 99.9% line coverage; `packages/db` 78 passing (rate table
seed).

## 2026-10-11: Phase 1 slices 2 and 4a, working days

**What changed**

- Task and workflow engine (PLAT-011): tasks with owner, due window, evidence and states; recurring
  series in UK local time materialised 48 hours ahead; overdue escalation to the nurse in charge;
  workflows with permissions, reasons, step-up, separation of duties and SLAs from the rate table.
- Document store and retention core (PLAT-009, PLAT-012): versioned documents with categories,
  content sniffing, ClamAV scanning (mock in development), typed-name signatures, person photos;
  legal holds; destruction with certificates that deletes every S3 version (ADR-0031).
- Point-of-care record (slice 4a; CARE-009, CARE-010, CARE-012 partial): append-only notes,
  observations and body-map marks with device-generated ids, late-entry and clock-drift flags
  measured from when the entry was made on the device, corrections by supersede; vital signs
  scored with NEWS2 and escalated to the nurse in charge; IDDSI checks; fluid balance by UK day;
  body-map side agreement and safeguarding prompts; the person's care profile.
- Working days (`docs/specs/calendar.md`, `bank_holiday`): GOV.UK bank holidays 2024 to 2028 per
  nation, a working-day deadline helper, and a `working_days` SLA unit for workflows.
- Web copy moved into the i18n catalogues, and `TextArea` and `AccountMenu` added to `@harbour/ui`
  (pull request #7).
- CI on the Phase 0 pull request is green: gitleaks scoped to a pull request's commits, CodeQL
  gated locally from SARIF, unfixable audit advisories recorded as exceptions.

**Next**: slice 4b and the domain rules for slices 6, 7 and 8 (in progress on their own branches),
then their schema and API.

**Human actions logged**: H-16 (ClamAV sidecar), H-17 (enable code scanning), H-21 updated.

**Tests**: `packages/domain` 813, `packages/db` 112, `apps/api` 131, all passing locally.

## 2026-10-11: Phase 1 rules for handover, people, MCA and incidents; care planning built

**What changed**

- Shift handover and round view rules (slice 5 domain, HZ-018), revised after a clinical safety
  review: shifts to the minute with any number per location, unacknowledged urgent alerts and
  skipped tasks carried over, refusals from every chart, acknowledgement by items seen.
- People lifecycle spec and rules (slice 8 domain): states and the read-only rule after exit,
  pre-admission and decision to admit, beds, property and keys, welcome checklist, About Me, review
  scheduler, hospital transfer pack, discharge, transfer and death workflows, sharing, the weekly
  break-glass report; hazards HZ-022 and HZ-023.
- Care planning built end to end (slice 4b): care plans with publication and sign-off, risk
  assessments rated with the NPSA matrix (ADR-0032 proposed), validated tools run on the server
  with MUST rescreen and weight schedules, advance care records with the resuscitation status on
  every person summary (HZ-015), activities and Reg 9A visits; migrations 0016 and 0017; hazards
  HZ-024 and HZ-025.
- Consent, capacity, best interests and DoLS rules, and the incident classifier for CQC
  regulations 16 and 18, RIDDOR, s.42, candour (20(9)), LeDeR, medical examiner, missing persons
  and UKHSA, with clocks, outbreak detection and the post-fall checklist (slices 6 and 7 domain);
  the safety spec corrected against the regulations; hazards HZ-026 and HZ-027.
- CI: the breaking-change check reads the OpenAPI document again (inclusive bounds); the
  accessibility scans wait for animations; test database teardown no longer races.
- The API and worker survive an idle database connection being ended (pool error listeners).

**Next**: schema and API for slices 6 and 7, then 8, then 5; web UI and offline Care mode.

**Human actions logged**: H-27, H-28, H-38, H-39, H-58 to H-66; H-22 and H-25 extended.

**Tests**: `packages/domain` 1,836, `packages/db` 142, `apps/api` 161, all passing locally.

## 2026-10-11: Web copy into the catalogues; text area and account menu in the design system

**What changed**

- i18n: every word in the web app's own code now comes from `@harbour/i18n` (138 new keys, 198 in
  all; a few `@harbour/ui` defaults without a prop remain, see Next):
  sign-in and set-up errors, the offline banner, people table headers, the person header, the
  break-glass sheet, the security settings page, the home tiles, notifications and error pages.
  Plurals, terminology and regulator names are ICU messages. Welsh has every key, marked
  untranslated in `cy.status.json`; new tests fail if a Welsh entry is still English but unmarked,
  or if an English message loses sentence case. `apps/web/src/copy.test.ts` parses every component
  and fails on literal copy in JSX text or in attributes people read or hear.
- `@harbour/ui`: `TextArea` (label, hint, error, character count with a maximum, described by all
  three; a polite live region reads the count once typing pauses; text is never cut off) and
  `AccountMenu` (Radix dropdown; name, email, organisation and location; link and action items;
  keyboard and screen reader behaviour unchanged). Stories in both themes; axe runs over each. The
  app bar now shortens organisation and location names on phones itself, and takes a translated
  skip link label; the app-level CSS override is gone. Story-level axe options are honoured for
  best-practice rules only (ADR-0026).
- Web shell: uses the package `AccountMenu` (now also showing the location) and `TextArea` in
  break-glass; one shared sign-out helper; break-glass reasons over 1,000 characters are refused
  by the form and the server action with a message, instead of being cut off by the browser.
- The manager journey waits for the sheet's fade-in before running axe; it had been measuring
  contrast on a half-transparent frame.

**Next**: label props for the remaining `@harbour/ui` English defaults (sidebar toggle, table
density, "None selected") before Welsh tenants; then Phase 1 as in STATUS.md.

**Human actions logged**: none.

**Tests**: `packages/i18n` 34, `packages/ui` 233 (160 axe runs), `apps/web` 142 unit and 8
Playwright journeys with axe, all passing locally; Biome, typecheck, Storybook build and the web
production build clean.

## 2026-10-11: The pull request stack merged to main

**What changed**

- Merged in order with merge commits: Phase 0 (#1, #7) and Phase 1 #2 to #6, #8 to #14, #16 to
  #20. Each later branch took `main` in first, with CI green on the result before it merged.
- Overlaps resolved in the merges:
  - `comms.md` is now one spec for letter templates (slice 11) and the family feed (slice 12). The
    feed keeps rules 1 to 17; the template rules are 18 to 26, and every reference moved with them.
  - The family channels use slice 11's printable-ASCII email check instead of their own, so a
    lookalike letter in a family member's address is refused as it is for letters.
  - Built-in roles keep both slices' exclusions: portal-only permissions, the evidence pack link
    (`quality.evidence.read`), and for the deputy, preparing a DPIA and approving the statement of
    purpose.
  - The export catalogue (slice 13) now classifies the consent, capacity, best-interests, DoLS,
    incident, classifier, statutory notification, candour and investigation tables from #14, with
    every column described and the stored codes explained (hazard HZ-071).
  - Hazard log, human actions, records of processing, data standards, retention and the decision
    index keep both sides in id order; the register is recounted and `permissions.md` regenerated.
- The shared UK wall-clock rule for typed event times (`resolveRecordedUkTime`, #16) is on `main`.
- gitleaks reads message catalogue keys as names, not secrets.
- Dependabot's seven alerts reviewed: the two high ones are recorded exceptions (build tooling
  with no fixed version); one moderate ships in the app and waits for the next Expo SDK.

**Next**: #21 (people lifecycle schema and API, round 3 fixes) and #15 (offline Care mode, round 4),
then the API follow-ups from the #15 reviews and slice 5's API (STATUS.md).

**Human actions logged**: none new in the merges. The project owner has moved the accounts and
the named roles to after the build and is choosing the SMS provider (H-09).

**Tests**: `packages/domain` 3,627, `packages/db` 190, `apps/api` 228, `apps/web` 282,
`packages/ui` 330, `apps/mobile` 208, `packages/ui-native` 133, `packages/i18n` 34,
`packages/contracts` 11, `packages/sync` 10, all passing locally on `main` plus #20.

## 2026-10-11: Phase 1 slice 8 review fixes (people lifecycle schema and API)

**What changed**

- Security review: confirming residents' money or a deposit at exit needs `finance.ledger.approve`
  with step-up and someone other than the recorder; rooms, the bed board and room clearance check
  the caller's locations; `people.sharing.manage` is a care-record permission and a share link
  needs step-up; About Me, the pre-admission assessment and property leave the PowerSync
  publication (0023); the transfer pack preview takes its reason in a POST body; the PDF and the
  transfer list need `people.movement.record` and the PDF is served sandboxed; 0024 audits the
  0022 role changes; the break-glass review refuses a self-review and other locations; replays,
  document and evidence ownership are checked and audited.
- Clinical review: a corrected death or discharge brings back the rounds it ended; an exit ends
  only rounds and point-of-care tasks; offline entries for a cancelled round are kept, linked and
  flagged; rule 3 has a clock tolerance and a review task; the pack prints the CPR decision in
  force with conflicts and overdue reviews on page 1, pre-admission medicines as needing checking,
  IDDSI as safety-critical, with Noto Sans embedded (ADR-0040) and PNG photos; return checks are
  tasks with an owner and a due time; death notifications belong to their exit record, and a
  correction raises a task to tell the CQC; LeDeR needs an explicit answer.
- Web: communication needs show "Not recorded" as a warning (icon and words) and "None
  identified" only for a positive none, through the message catalogues.
- API tests cover every review item, and every test the hazard log cites carries its hazard id.

**Next**: slice 5's API (care plan actions, handover, rounds), then the web UI for the record
(slice 9) and offline Care mode (slice 10), which brings the slice 8 tables back to devices with
assignment-pinned streams.

**Human actions logged**: H-82 to H-90 (CSO decisions from the clinical review and the ratings);
H-81 reworded.

**Tests**: `packages/domain` 1,917, `packages/db` 261, `packages/contracts` 16, `apps/api` 353,
`apps/web` 108 unit, all passing locally.

## 2026-10-11: Phase 1 slice 8 review fixes, round 3 (people lifecycle)

**What changed**

- Rounds after a return or correction: tasks and series carry the exit that stopped them, and
  migration 0023 codes existing rows from the event that stopped them, never from reason text. A
  task an entry answered while it was stopped is restored as done (the 10:05, 10:08, 10:15 and
  10:20 case); only tasks whose window ends at or after the return count; the latest missed
  occurrence of each series reopens as overdue and the review task lists every missed round. A
  correction returns the person to the status kept on the exit (active, on leave or in hospital).
- Entries and tasks: each entry stores the task it named and what it did to it (`task_outcome`);
  an entry for a round already done, or one its author may not complete, is kept, flagged and
  reviewed (`care.entry_review`), and refused for `medicines.*` tasks. The late-entry review names
  the entry by kind, client id, device and user. Contracts carry `taskOutcome`,
  `evidenceAfterClose`, task `details` and the exit's `statusBefore`; the web has badges for them.
- Transfer pack: photo decoding is bounded (chunk bounds, 4096 x 4096 pixels, capped inflate,
  never throws), 16-bit and interlaced PNGs count as not printable, the CPR decision is on page 1,
  home and hospital names are checked for unprintable characters, compressed fonts are cached.
- Security: return checks need their task's permission or its assignee; finance exit items are
  decided from the domain definition and checked against the stored row; deleted documents are
  not evidence; the allergy confirmer always comes from the session user; 0024 credits 0022 only
  with what it added for each role key; an incident's draft from a death recorded in error is
  withdrawn and never counts for a later death.
- `@harbour/ui` gains a `notRecorded` status chip that can link to the record action, used for
  allergies and communication needs not recorded.
- Docs: hazard log (HZ-003 to HZ-008, HZ-011, HZ-013, HZ-015, HZ-023), care.md rule 13, people.md
  rules 2 and 10, data standards, records of processing, ADR-0040.

**Next**: the coordinator merges main; then export catalogue entries for 0020 to 0024 and the
badges wired into main's chart and task views. Keeping a server copy of an entry refused after an
exit comes with the mobile hand-over of held entries.

**Human actions logged**: H-91 to H-94 and H-130; H-89 and H-90 updated.

**Tests**: `packages/domain` 1,944, `packages/db` 266, `packages/contracts` 16, `apps/api` 383,
`apps/web` 114, `packages/ui` 200, `packages/ui-native` 134, all passing locally.

## 2026-10-11: #21 after main: the slice 12 sharing rules, the export catalogue, entry flags

**What changed**

- Sharing API on the slice 12 rules: migration 0025 adds `sharing_decision_suspension` (periods,
  one open per decision, forced RLS, person scope, versioning, backfill) and a deputy's order
  sections; every check passes the periods and the current capacity finding for the sharing
  decision; a new lift-suspension route; authorities are checked against the contact who holds
  them (role, deputyship, order sections; appointees benefits only); the benefits section reaches
  the contracts, OpenAPI and client (HZ-022).
- Export catalogue: every table and column from 0020 to 0025 is classified, 15 of the tables as
  care records described column by column, with code meanings, units, the token hash secret and
  the workflow id internal (HZ-071).
- Web: every entry view shows the lifecycle flags beside the late-entry flag (C-M3); the unused
  person header keys are gone; main's header fixture gains the new person fields.

**Next**: round 4 of the #21 review.

**Tests**: `packages/domain` 3,684, `packages/db` 276, `packages/contracts` 16, `apps/api` 387,
`apps/web` 299, `packages/ui` 337, `packages/ui-native` 134, `packages/i18n` 34, all passing
locally.

## 2026-10-11: #21 review round 4 (people lifecycle)

**What changed**

- Rounds: a missed round is caught up only when no later occurrence is done or open again, with a
  fresh window and its escalation reset; a missed medicines dose is never made due again but listed;
  a return or correction first makes the rounds the series would have had since it stopped (a stay
  beyond the 48-hour horizon, a late correction); a correction after the exit workflow closed still
  restores the status and rounds; restored tasks carry a restore code (migration 0026).
- Entries: a medicines entry that cannot complete its task is kept as `medicines_conflict` with an
  urgent conflict review instead of being refused; the task row is locked while an entry is
  planned, a second entry for an answered cancelled task is reviewed, replays return the stored
  entry first, review details are capped.
- Security: a task goes only to someone who holds its permission at its location; photos are capped
  at 2048 pixels a side with chunk and size limits, decided printable once at upload and never
  decoded inside a transaction; the pack routes are rate limited per user; refusals are audited
  after their transaction; device ids are kept only when opaque; the chip links only to this site
  and names its action.
- Page 1: an ADRT held without a CPR form says so; a missing confirmer is said; the conflict is said
  once in sentence case. Web: the medicines conflict badge on every entry view. The catch-up and
  restored badges and the review details view are built and tested but on no screen yet (corrected
  in round 5: they come with the task views, Phase 1 slice 9; HZ-006).

**Human actions logged**: H-131 to H-136; H-90, H-92 and H-94 updated.

**Follow-ups**: mobile badges and details (#15); the server copy of a refused entry (H-134).

**Tests**: `packages/domain` 3,695, `packages/db` 278, `packages/contracts` 16, `apps/api` 411,
`apps/web` 304, `packages/ui` 342, `packages/ui-native` 134, `packages/i18n` 34, all passing
locally.

## 2026-10-11: #21 review round 5 (people lifecycle)

**What changed**

- Exits: the urgent review of a possible second dose (`care.entry_conflict_review`) stays open when
  a death or discharge is recorded after it, like the other entry review (M1, HZ-004). No other
  review or safety task kind had the gap.
- Missed rounds: the review lists missed medicines rounds first and never drops them, then the
  rest newest first, 50 in all with the rest counted; the look back starts at 00:00 UK time seven
  days before, and when rounds before it were not made the review says from which date rounds are
  not all listed (M2, HZ-003, H-137). The review details name a medicines round in words.
- Page 1 of the transfer pack: with an advance decision to refuse treatment in force, every CPR
  line adds "An advance decision to refuse treatment is also held (dd/mm/yyyy): read it before
  acting." (M3, HZ-015, H-133).
- Tasks: an assignee completes a task (by the task route, an entry or a return check) only while
  they could still be given it, so an expired or revoked acting-up grant no longer lets them mark
  it done or skipped; refusals are audited, an entry is kept and reviewed. A task or series about a
  person created with an assignee is checked the same way. General tasks and investigation actions
  are exempt (security S1 follow-on and low).
- Docs: the on-screen display of review details and task badges is a planned control under HZ-006
  (Phase 1 slice 9); the round 4 changelog line is corrected; H-135 notes its default awaits the
  CSO.

**Human actions logged**: H-137; H-90, H-94, H-133 and H-135 updated.

**Follow-ups**: the task views that show review details and task badges (Phase 1 slice 9).

**Tests**: `packages/domain` 3,710, `packages/db` 278, `packages/contracts` 16, `apps/api` 422,
`apps/web` 306, `packages/ui` 342, `packages/ui-native` 134, `packages/i18n` 34, all passing
locally (the fluid balance test in `apps/api` fails only in the half hour after midnight UK time,
when its entries fall on two days).

## 2026-10-11: #21 review round 6 (people lifecycle)

**What changed**

- Entries: whether an entry's author may complete the task it names is judged when the care was
  recorded (`entryPermissionTime`), for the assignee and for anyone else: a carer acting up whose
  grant ended before the device uploaded still completes the round they did, so it is not left
  open inviting a second dose; a revoked grant never counts; the time is never earlier than the
  task was made, so an entry backdated to an earlier grant completes nothing (HZ-004, HZ-006,
  H-138). Done or skipped by hand is still judged at the server's time.
- Audit: a refused completion by an entry is audited only by the upload that saved the entry, so a
  duplicate upload that loses the race records nothing.
- Tests: a care worker acting up completes a task by the task route and by an entry, and their own
  roles and grants are read under row-level security.

**Human actions logged**: H-138; H-132 updated.

**Tests**: `packages/domain` 3,713, `packages/db` 278, `packages/contracts` 16, `apps/api` 427,
`apps/web` 306, `packages/ui` 342, `packages/ui-native` 134, `packages/i18n` 34, all passing
locally (run with `--concurrency=3`: under full parallel load a web time-zone test that reads every
minute of a day can pass its 5-second limit).

## 2026-10-12: Phase 1 slice 5 API (tasks, rounds and handover)

**What changed**

- Specs: care.md rule 8 as built in slice 5 and new rule 14 (care plan rounds), the slice 5 route
  permission matrix, schema rows, tests and open questions; comms.md (COMMS-006 built with the
  handover); two rate-table defaults for the window around a care plan round
  (`care_plan.task_window_before_minutes` 30, `care_plan.task_window_after_minutes` 60, to
  verify); retention.md (the handover tables are care records).
- Domain (tests first): `plan-tasks.ts` (which series a plan needs, carried forward unchanged
  across versions or ended; windows cut so no instant is inside two rounds' windows, even on a
  clock-change night); the medicines domain never generates tasks; handover additions
  (`previousShift`, `handoverOpen`, `alertConditions`, `viewerAcknowledgement`,
  `checkHandoverAcknowledgement`, `checkHandoverNote`, `lateAdditionSeverity`).
- Database: migrations 0027 and 0028: `handover` (items only ever added: a trigger refuses
  removing, changing or reordering one, moving the shift or unlocking), `handover_note` and
  `handover_acknowledgement` (append-only, client ids, acknowledgements only for oneself),
  forced RLS with a location scope that follows the people a reader can see,
  `care_plan_action.based_on_action_id`, one live task series per care plan action, and
  `notification.person_id` and `location_id` with a backfill from each alert's source. Export
  catalogue entries for the new tables and columns.
- API: publishing a plan generates its rounds (and an hourly sweep, as the system); the round view
  with the point-of-care header on every stop; the handover list, compile or refresh, detail,
  notes and acknowledgements, compiled in the system's view and read in the reader's; who is
  pending and who hears of a late addition worked out over each member's own scope with the
  database's person-scope policy; a worker job every 5 minutes locks each shift's handover and
  appends late additions (reading back 10 minutes so an entry committed just after a refresh is
  never missed); urgent alerts carry their person and location; the task series end route
  refuses a care plan series. OpenAPI and the client regenerated (no breaking change).
- Docs: hazard log (HZ-018, HZ-024, HZ-003, HZ-004, HZ-008, HZ-001, HZ-011), records of
  processing, data standards, feature register rows CARE-013 and COMMS-006.

**Human actions logged**: H-150 to H-154 (CSO).

**Follow-ups**: round and handover screens (web slice 9, Care mode slice 10 part 2, with sync
streams for tasks and handovers and offline acknowledgement); moving a person's care plan rounds
when they move location; a worded summary per handover item; rota-defined shifts and incoming
staff (Phase 2).

**Tests**: `packages/domain` 3,836, `packages/db` 306, `packages/contracts` 29, `apps/api` 506,
`packages/sync` 59, `apps/mobile` 807, `apps/web` 306, `packages/ui` 342, `packages/ui-native` 141,
all passing locally through `scripts/ci-local.sh` (every gate).

## 2026-10-12: #24 review round 2 (tasks, rounds and handover)

**What changed**

- Handover security (S-M1, S-M2, S-M3): items moved from a JSON column into the append-only
  `handover_item` table (one row each, unique key and position), readable only by staff who can
  see the item's person; only the system's view (scope `tenant`) may insert or update a handover
  or its items, and the guard also refuses a change of organisation or a soft delete; a note on an
  item takes its person from the item by trigger and needs an item the writer can see (composite
  foreign key). Readers who are not a tenant-wide role or a role at the location see counts over
  their own items, only their own acknowledgements, and no hidden count or version. An
  acknowledgement sends the seen token of the view the reader was shown; the server records the
  keys of the items they could see and refuses an old token with 409. Compiling refuses a time
  before the offline window and is limited per user a minute
  (`HANDOVER_COMPILE_REQUESTS_PER_MINUTE`). Alerts reference their person by a composite foreign
  key; notices about late additions are urgent only from items the recipient can see.
- Round windows (C-M1): worked out from the real instants of consecutive rounds (`roundTimes`),
  each side under half the real gap and capped by the rate table, never nothing; times under 10
  minutes apart refused, and occurrences a clock change makes one instant merged; used by the task
  engine and the lifecycle's gap filling. Table tests over the 2026 and 2027 clock changes.
- Plans and rounds (C-M2, C-M7): a round from a changed plan says "From an earlier plan: check the
  current plan" with the plan's status; a plan change no longer cancels a round in progress;
  medicines actions say "Not a round: see the medicines record" on the plan and on the round stop.
- Header (C-M3): the point-of-care summary carries the prescribed IDDSI food and drink levels, or
  `not_recorded`.
- Handover rules (C-M4 to C-M6): late additions reach the nurse in charge when no acknowledger can
  see them, and always for falls, raised NEWS2, incidents and urgent alerts; only an acknowledgement
  at or after the shift's end covering everything its author can see counts for the incoming
  shift, and the nurse in charge gets one alert after `handover.acknowledgement_grace_minutes` (60,
  to verify); a fixed `handover` note tag ("Include in handover") is compiled, and the
  closed-handover message names it.
- Worker: the sweep compiles and locks every shift missed within the offline window; one
  organisation's failure no longer stops the others and is audited (`platform.job.tenant_failed`);
  the nurse in charge and staff scope honour assignment validity and staff status.
- Migrations 0027 and 0028 amended in place (not yet on `main`), snapshots and journal regenerated
  with drizzle-kit; OpenAPI and the client regenerated.
- Docs: hazard log (HZ-001, HZ-003, HZ-004, HZ-008, HZ-011, HZ-016, HZ-018, HZ-024), care.md,
  comms.md, rates.md, data standards, records of processing.

**Human actions logged**: H-150 to H-154 reworded; H-155 (which notes reach the handover).

**Tests**: `packages/domain` 3,902, `packages/db` 313, `packages/contracts` 30, `apps/api` 513,
`packages/sync` 59, `apps/mobile` 807, `apps/web` 306, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: #24 review round 3 (tasks, rounds and handover)

**What changed**

- Items about nobody (an incident with no residents, the safety tasks and alerts it raises, a
  check of the building) are visible only to readers who see the handover whole, in the database
  (`handover_item_scope` with `app.handover_whole`) and in the API's view of each member of staff
  (`staffCanSee`); a note on an item follows its item (`app.handover_item_visible`), and a note on
  the whole handover still reaches every reader.
- The incoming shift has acknowledged only when every item is covered by at least one
  acknowledgement made at or after the shift's end, by the keys each recorded, so one narrowly
  scoped acknowledgement no longer clears the handover and access that ends later does not undo it.
- Late-addition notices are never sent before the receiving shift starts (no flood from refreshing
  a shift still running), and only acknowledgements on the receiving shift make someone a
  recipient (an outgoing read-back never does).
- With no nurse in charge at a location, the unacknowledged-handover alert goes to the
  longest-serving Registered Manager anywhere, else the longest-serving holder of
  `care.handover.manage`; with no one, the gap is audited once (`told: 0`).
- Round times under 10 minutes apart are refused for every frequency (a weekly Monday 23:55 and
  Tuesday 00:00 included); merge tests for 01:30 and 02:30 and 01:05 and 02:00.
- The closed-handover message says a note timed within the closed shift is added to it, and the
  next handover carries it.
- Docs: hazard log (HZ-003, HZ-004, HZ-008, HZ-011, HZ-018), care.md, H-150, H-153 and H-154, and
  the on-call runbook (`platform.job.tenant_failed` needs an alert once monitoring exists).

**Tests**: `packages/domain` 3,914, `packages/db` 314, `apps/api` 514, all passing locally through
`scripts/ci-local.sh`.

## 2026-10-12: Sync and device integrity (the #15 follow-ups)

**What changed**

- Device binding (`device_binding`, migrations 0029 and 0030): one row per device and member of
  staff, written by the sync token and by device reports and filled from the audit trail; the
  bound owner of a hold and its start floor read it instead of scanning `audit_event`.
- Revocation: `GET /v1/devices` and `POST /v1/devices/{deviceId}/revoke`
  (`platform.device.read`, `platform.device.revoke` with step-up; migration 0031 gives existing
  role copies both, audited). A revoked device is refused with 403 `device_revoked` on the sync
  token, batch upload and care entry uploads; the app wipes as a remote wipe, or keeps its
  unsent entries under the hold rules, marked revoked, and never resumes syncing.
- Deletion lists (`device_discard_entry`, migrations 0032 and 0033): each stage of a deletion
  lists its entry ids, and the flag on entries uploaded after their deletion reads them with one
  index, closing the HZ-040 go-live blocker on that lookup.
- One open sync task per source: migration 0034 closes duplicates an earlier race left and
  0035 adds a partial unique index on open device-hold, flagged-entry and refused-entry review
  tasks; flagged tasks carry their owner, count and entries in `task.details`.
- Server copy of refused entries (`refused_entry`, migrations 0036 and 0037):
  `POST /v1/sync/refused-entries`, `GET /v1/people/{id}/refused-entries` and
  `GET /v1/refused-entries/{id}`, one review task per person for the nurse in charge (HZ-006);
  the app sends each refusal's content at once and again after each sync until the server has
  it (`upload_issue.server_copy`).
- Hand-over of held entries (`care.held_entry.hand_over`, step-up; migration 0038): a manager,
  or the owner on a revoked device, sends another member's held entries from the device, written
  as the owner's with the sender audited (`sync.entry.handed_over`).
- Shared quotas (`request_quota`, migrations 0039 and 0040): `PerUserQuota` and `RateLimiter`
  count in Postgres, so the limits hold across API instances.
- OpenAPI and the client regenerated; permission matrix regenerated; export catalogue entries
  for the four tables; Welsh catalogue keys added and listed as untranslated.
- Docs: care.md and platform.md (Device integrity), retention mapping, hazard log (HZ-004,
  HZ-006, HZ-008, HZ-010, HZ-011, HZ-023, HZ-040), records of processing, data standards,
  feature register (PLAT-004, PLAT-011, MOB-005, MOB-006, MOB-010).

**Next**: review of this branch; the device and refused-copy screens in the web record
(slice 9) and the "copy sent" wording on the phone; the stale-device check (H-141); the rest of
the #15 API follow-ups (STATUS.md item 2).

**Human actions logged**: H-156 (a revoked device's held entries), H-157 (the refused-entry
review), H-158 (the hand-over), H-159 (the new processing); H-68, H-126, H-134, H-141 and H-142
updated.

**Tests**: `packages/domain` 3,914, `packages/db` 335, `packages/contracts` 30, `apps/api` 543,
`packages/sync` 59, `apps/mobile` 853, `apps/web` 306, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: #25 review round 2 (sync and device integrity)

**What changed**

- Hand-over (security H1, clinical M3; HZ-040, HZ-004): taken only from a sender bound to the
  device (the app sends its report from the sender's sign-in first), while the device's last
  report shows a hold for the owner, within the count of the hold's report from someone other than
  the sender, for entries timed while the owner used the device (and before any revocation),
  about someone in the owner's care within the offline window. Each entry is recorded in
  `handed_over_entry` (a hand-over id names one owner, device and sender) and keeps its sender in
  `handed_over_by`, returned as `handedOverBy` ("Sent by"). Refusals are 422 `handover_refused`.
- Device (clinical H1; HZ-006): on a hand-over, a 404, any 403 or `handover_refused` stops with
  the entry still held, never parked; the database is deleted only when no held and no
  needs-attention entry remains, whatever the server's copies.
- Revocation (security M1, clinical M2; HZ-040): the sessions bound to a device are recorded
  (`device_session`) and ended at revocation, and any request from one is refused whatever it
  names; a revoked device's hold is due at once and urgent, its manager told, and a revocation of
  a device with entries waiting needs the count confirmed.
- Copies (security M2, clinical M1; HZ-006, HZ-008): content checked against the entry kind's
  contract; only about someone the author cared for (refused like an unknown person otherwise); a
  revoked device's copies only with a hand-over; the review escalates with the fallback and tells
  the nurse in charge when urgent; copies the server will not keep are counted and said on the
  phone.
- Lows: device list filtered before its limit; a location role revokes only its own staff's
  devices; RLS narrowed on `device_binding`, `device_discard_entry` and `request_quota`;
  hand-over headers in OpenAPI; revoked-device refusals audited once an hour; 0034 carries
  urgency, due time, progress and flagged entries to the kept task; copy limit after replay,
  against the owner; copies paged; 0035's index lock noted.
- Migrations 0041 and 0042 added; 0030, 0033, 0034, 0035 and 0040 amended in place (not on
  `main`). A time-of-day flaky handover test now uses the sweep's own window.
- Docs: hazard log (HZ-004, HZ-006, HZ-008, HZ-011, HZ-040), care.md, platform.md, retention,
  records of processing, data standards, H-134, H-141, H-142, H-156 to H-159.

**Human actions logged**: H-134, H-141, H-142 and H-156 to H-159 reworded.

**Tests**: `packages/domain` 3,914, `packages/db` 338, `packages/contracts` 30, `apps/api` 553,
`packages/sync` 59, `apps/mobile` 861, `apps/web` 306, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: #25 review round 3 (sync and device integrity)

**What changed**

- Hand-over count (security item 1; HZ-040, HZ-004): the count comes from the latest report in the
  device's open hold not sent by the sender, the owner's own preferred; the sender's own reports
  are skipped, never counted, so a sender reporting nothing and then a large count is refused.
  With no such report the hand-over is refused; a second holder's confirmation is for the CSO and
  DPO (H-158).
- Hand-over times and care (clinical M1; HZ-040, HZ-006): an entry is judged by when it was
  written on the device (else its event time), with `sync.clock_drift_flag_minutes` either side
  of the owner's first use, the report that set the count and any revocation; the owner's care is
  measured back from the entry's own time. Each entry is checked before its transaction and
  admitted in it by `app.admit_handed_over_entry` (one hand-over id, then one hold, at a time), so
  a refused write uses none of the count; handed-over copies of refused entries are admitted the
  same way. On the device, an entry the server will not take stays held with its reason
  (`held_entry.handover_refusal`) and the rest are sent.
- Revocation (clinical M2; HZ-040, HZ-006): sessions are no longer ended. The tenant middleware
  refuses every request from a session bound to a revoked device with 403 `device_revoked`
  except its device report, which may raise or hurry the task but never close it, and binds the
  session on any request naming a device (not the report, nor a hand-over). A replayed revocation
  hurries again, moving only what is not yet due and urgent. The device list and the revocation
  return `lastReportedAt`.
- Waiting count (clinical M3; HZ-006): refused entries with no server copy count as waiting; the
  hand-over's partial message no longer sends staff to a list nobody can open.
- Upload queue (clinical M4; HZ-006): the hand-over holds anything left in the upload queue first,
  counts the queue in what is left, and never deletes the database when a count cannot be read.
- Lows: RLS location clauses read only live, undeleted role assignments (`device_binding`,
  `device_discard_entry`, `handed_over_entry`); `device_session` is read by its member or a job
  and bound only by its member in the system's view; the refused-entry review's urgent notice
  goes to the fallback when no nurse in charge exists; the capped-holds hurry and the later
  report are asserted deterministically.
- Migrations 0030, 0033 and 0042 amended in place (not on `main`; SQL only, no snapshot change).
- Docs: hazard log (HZ-006, HZ-040), care.md parts 1, 2 and 6, platform.md, data standards,
  H-134, H-141, H-156 and H-158.

**Human actions logged**: H-134, H-141, H-156 and H-158 reworded (H-158 records that a second
holder's confirmation is a CSO and DPO decision and that no screen shows "Sent by" yet).

**Tests**: `packages/domain` 3,914, `packages/db` 341, `packages/contracts` 30, `apps/api` 562,
`packages/sync` 59, `apps/mobile` 863, `apps/web` 306, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: Care API follow-ups (the rest of the #15 reviews)

**What changed**

- IDDSI on the server (HZ-016, C3): `checkIddsiEntry` needs a drink's level whenever a drink level
  is prescribed. The web is refused, naming the prescribed level; an entry from a device is kept,
  flagged (`flags.iddsiProblem`: `level_not_recorded`, `reason_missing`, `prescribed_unreadable`)
  and, when it may not be safe, alerts the nurse in charge. The web shows the flag in words with
  an icon on the saved entry.
- Escalation policy link (HZ-012, HZ-014; medical-device boundary rule 4):
  `escalation_policy_link` (per tool, optional band and location; migrations 0043 and 0044) and
  `GET`, `POST`, `PUT /v1/escalation-policies` with `.../{linkId}/remove` (`quality.policy.manage`,
  a location role only for its locations). Every NEWS2, MUST, Waterlow, Braden and falls result
  returns `escalationPolicy`, or `not_configured`.
- Body-map side on the server (HZ-019): the shared drawing (`BODY_MAP_DRAWING`) and
  `sideFromDrawing`; marks carry `drawnAt` or `drawnZone`, the server works out and stores the side
  (`drawn_x`, `drawn_y`, `drawn_zone`, `drawn_side`) and refuses any disagreement. The web sends
  each spot (some spots moved so each reads as its own side); the phone sends the point tapped or
  the zone chosen, and an entry queued before as the zone its drawn side names.
- Discard reasons, replay index and flag (HZ-040): `discard_reason` per organisation, seeded by a
  trigger on `tenant` and by the migration, with `GET`, `POST`, `PUT /v1/discard-reasons`
  (`platform.tenant.manage`, tenant-wide); `SyncDiscard.organisationReasonCode`;
  `device_discard_record`, unique on deletion and stage, as the replay guard;
  `entry_device_deletion_flag` and `deviceDeletion` on every entry item. Both tables filled from
  the audit trail by migration 0044.
- Staff names: `StaffName` (display name and job title) beside every staff id in care responses
  (entries, sign-offs, publications, history, tasks, rounds, handovers, MCA records, refused
  entries), read under the caller's row-level security.
- Client ids (HZ-029): `id` on `CreateAdvanceCareRecord`, `CreateRiskAssessment`,
  `CreateCarePlan`, `CreateCarePlanAction`, `CreateConsent` and `CreateDols`, and the
  `Idempotency-Key` header on every care create route; the web now sends kept ids for advance
  care records, risk assessments, care plan drafts and actions.
- OpenAPI and the client regenerated (additive only; `oasdiff breaking` clean); export catalogue
  entries for the four tables; Welsh catalogue keys added and listed as untranslated.
- Docs: care.md (sections 2 to 7, 9 and 10; Device integrity part 8), hazard log (HZ-012, HZ-014,
  HZ-016, HZ-019, HZ-029, HZ-040), medical-device boundary, records of processing, data standards,
  retention mapping, feature register (CARE-001, CARE-002, CARE-003, CARE-007, CARE-010,
  CARE-012, CARE-015, CARE-021, CARE-022, MOB-006).

**Next**: review of this branch; the screens for the escalation policy link, staff names and the
deletion flag (H-73), settings screens for links and coded reasons, the phone offering the
organisation's reasons (H-164); the stale-device check (H-141); client ids on create routes outside
care.

**Human actions logged**: H-160 (IDDSI entries kept from a device), H-161 (the new processing and
staff names), H-162 (the body map drawing), H-163 (the escalation policy lookup), H-164 (coded
reasons per organisation); H-73, H-74 and H-146 updated.

**Tests**: `packages/domain` 3,996, `packages/db` 365, `packages/contracts` 34, `apps/api` 586,
`packages/sync` 59, `apps/mobile` 869, `apps/web` 311, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: #26 review round 2 (care API follow-ups)

**What changed**

- IDDSI in words (clinical C1; HZ-016): the web shows every kept problem in words beside its icon,
  `prescribed_unreadable` included, and says "it may not be safe: the nurse in charge was told"
  only when the entry raised the alert (a thinner drink or more solid food than prescribed); a
  refused drink needs no level and raises nothing, on the server, the web and the phone.
- Urgent alert routing (clinical C2; HZ-016, HZ-012): with no nurse in charge on shift, the IDDSI
  and other urgent care alerts go to the fallback (the Registered Manager, else holders of
  `care.plan.write`); only notifications written are counted; with no one to tell,
  `care.alert.unrouted` is audited (opaque ids only).
- Flagged entries in totals (clinical C3; HZ-040): the fluid day returns `flaggedEntries`,
  `flaggedIntakeMl` and `flaggedOutputMl`; every list carries `deviceDeletion`; the web shows an
  icon and words on the entry and beside the day's total. Nothing is left out (H-165).
- Older phones' marks (clinical C4; HZ-019): a mark with only a drawn side is stored at the zone
  that side names and flagged (`body_map_mark.drawn_from_device_side`, migration 0045); the spec
  line saying such marks are refused is corrected. A refused copy of a category 2 or worse pressure
  ulcer, a bruise or an injury makes the review task and notice urgent (H-162).
- Replays (clinical C5; HZ-029): a resent create with the same id and other material details is
  refused with 409 "This was already saved with different details: reload before changing it."
  (advance care records, risk assessments, care plan drafts and actions, consents, DoLS,
  escalation links); a replayed link that has since been removed is refused, never returned.
- Escalation policy on the web (clinical C6; HZ-014, HZ-012): assessment results and the
  observation list show the linked policy as a link to the document, or "No escalation policy is
  configured for this result" with an icon; `validatedToolsWithLinks` feeds the onboarding item
  `escalation_policies_linked` from the links (bands and locations covered), for the onboarding
  route to call; the demo seed links a NEWS2 policy; Playwright and axe cover both states.
- Who may change links and reasons (security S1; HZ-012, HZ-040): decided from the role
  assignments and grants that carry `quality.policy.manage` or `platform.tenant.manage`
  (`placesHoldingPermission`, `app.holds_permission_at`, migration 0046), in the API and in RLS,
  never from the merged scope; `resolveAccess` unchanged.
- Lows: `GET /v1/discard-reasons` needs `care.note.write`; handover notes and acknowledgements,
  capacity and best-interests records lock their client id and answer a used id with 422, never
  500; `entry_device_deletion_flag` is unique on tenant, table and entry, and flags are looked up
  by table and id; the audit names an organisation's reason by id, not its text; the policy
  document must be the current version of an organisation policy; a care plan action's replay is
  labelled with its stored section's domain. Migration 0044's backfill skips flags already there.
- OpenAPI and the client regenerated (additive; `oasdiff breaking` clean).
- Docs: care.md (rules 5 to 7, permissions, sections 5, 6 part 8, 9 and 10), hazard log (HZ-012,
  HZ-014, HZ-016, HZ-019, HZ-029, HZ-040), medical-device boundary, data standards, records of
  processing, feature register (CARE-003).

**Human actions logged**: H-165 (flagged entries in totals), H-166 (the IDDSI level compared with
the prescription at upload, not at the time given); H-73, H-160, H-162 and H-163 updated (H-163
notes that a location's all-bands link wins over an organisation's band-specific one).

**Tests**: `packages/domain` 4,014, `packages/db` 366, `packages/contracts` 34, `apps/api` 598,
`packages/sync` 59, `apps/mobile` 870, `apps/web` 327, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: #26 review round 3 (care API follow-ups)

**What changed**

- Alert recipients (item 1; HZ-014, HZ-016): an urgent result alert goes only to someone who can
  open the person's record (`staffViews`, moved to `services/staff-views.ts`, now with each
  member's permissions), on the staff and with a role in force: the nurse in charge, else the
  Registered Managers across the organisation, other Registered Managers who can see the person,
  then holders of `care.plan.write` who can. Its title names the home. The route is worked out
  before the entry is written and kept as `flags.alertRoute`; with no one, nothing is counted
  and `care.alert.unrouted` is audited with a coded reason (`CareTrigger.code`, for example
  `news2_threshold`). The sync tasks' fallback is unchanged.
- Replays (item 2; HZ-029, HZ-015): a resent create with other details is refused with 409
  `already_saved_differently`, and the web says what was saved stands, to reload, check it and
  enter the change again. A care plan draft is compared on `copyFromActive` too
  (`care_plan.copy_from_active`, migration 0047).
- NEWS2 after saving (item 3; HZ-012, HZ-014): the result shown and focused after saving vital
  signs names the escalation policy from the save's response.
- Onboarding wording (item 4): the hazard log, care.md and H-163 say the onboarding rule is
  built and the route that calls it is not.
- Refused drinks (item 5; HZ-014): a drink offered and refused adds nothing to the intake or the
  shortfall; the fluid day returns `refusedEntries` and `refusedOfferedMl`; the web shows them
  beside the total, and a refused drink reads "200 ml offered" on the web and the phone (H-167).
- Lows: the web says who an alert reached from `alertRoute` (or "Check that the nurse in charge
  knows." for an older alert); a refused pressure ulcer with no category, or an unreadable one,
  is reviewed urgently; the S1 tests are named for HZ-012 and HZ-040, with table-driven Postgres
  cases for ended, future and deleted assignments, archived and mixed roles, and expired,
  revoked and deleted grants; `app.holds_permission_at` skips roles mixing portal and staff
  permissions (0046 amended, not on `main`); coded reasons are changed by id
  (`PUT /v1/discard-reasons/{reasonId}`, `DiscardReasonItem.id`) and audited by id only.
- OpenAPI and the client regenerated (additive against `main`); Welsh catalogue keys added as
  untranslated.
- Docs: hazard log (HZ-012, HZ-014, HZ-016, HZ-019, HZ-029, HZ-040), care.md (rules 5 and 6,
  permissions, schema, sections 5, 6 part 5 and 8, and 9), medical-device boundary, data
  standards, STATUS.md.

**Human actions logged**: H-167 (whether refused drinks are shown beside the total); H-73 (the
not-configured line on every band, NEWS2 0 included), H-160 (who the alert reached, in words)
and H-163 (the onboarding route not yet built) updated.

**Tests**: `packages/domain` 4,018, `packages/db` 381, `packages/contracts` 34, `apps/api` 609,
`packages/sync` 59, `apps/mobile` 871, `apps/web` 338, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: #26 review round 4 (care API follow-ups)

**What changed**

- Test names (M1; HZ-014): the refused-drink tests are named for HZ-014 (the domain cases in a
  describe of their own, the API describe and the web test), and the hazard log cites them by
  their exact names.
- Alert routing tests (M2; HZ-014, HZ-016): one table-driven API test,
  `hazard HZ-014 hazard HZ-016 an urgent alert's fallback order, and the staff it skips (#26
  review round 4)`, runs `urgentAlertRecipients` and `raiseCareTriggers` in an organisation of
  its own per case: a nurse in charge who can see first; an organisation-wide Registered Manager
  before one at the home; a Registered Manager who can see before care plan holders, never one
  who cannot; a nurse in charge who cannot see; suspended and departed staff; ended and future
  assignments; nobody qualifying (route `no_one`, nothing counted, the coded reason audited).
  Every case passed against the round 3 code; reordering the tiers makes case (a) fail.
- Minor: the fallback is said by role, not rota ("The alert went to a manager or another member
  of staff who can see this person, not to a nurse in charge here."); the hazard log cites
  `hazard HZ-029 a save sent twice with the same client id is recorded once` exactly; the phone's
  unsafe-level copy says "When this is sent, the nurse in charge or a manager will be told. Tell
  them now if you can." (en-GB and cy; already listed as untranslated); the API fluid tests run
  on a fixed day, so they pass at any hour; platform.md says lock-screen push text stays generic,
  with no location or person name; the fallback's per-candidate reads are noted in STATUS.md
  (item 11) for measuring against the 100 ms budget.

**Human actions logged**: H-160 reworded (the fallback wording).

**Tests**: `packages/domain` 4,018, `packages/db` 381, `packages/contracts` 34, `apps/api` 616,
`packages/sync` 59, `apps/mobile` 871, `apps/web` 338, `packages/i18n` 48, all passing locally
through `scripts/ci-local.sh`.

## 2026-10-12: Data scope is per permission (security fix, ADR-0071)

**What changed**

- The defect: `resolveAccess` took the widest data scope across every role, whatever each role
  carried, and the API set that one scope as every request's row-level security context. A care
  worker at one home who also held an organisation-wide finance role read and wrote care records
  at every home; a grant's permissions applied wherever the user's roles reached, not where the
  grant was given.
- Domain: `EffectiveAccess` carries a scope per permission (`scopes`, read with `scopeFor`): the
  union of the active, non-mixed roles carrying it and the grants carrying it (a grant at its
  location, or the whole organisation without one). The merged `scope` and `locationIds` are
  removed. `narrowestScope` (several permissions at once) and `widestScope` (alternatives) are pure
  functions with table-driven tests. Search holds each kind of record and each document category
  to its own permission's scope.
- API: a request starts with scope `none`; `requirePermission` narrows it to the permission's
  scope, intersected with any required before; `requireAnyPermission` to the union of the
  alternatives the session may use. `SCOPE_WITHOUT_PERMISSION` is the explicit allow-list of routes
  every member uses that borrow `people.person.read`'s scope (the task list, task moves and
  document lookups), enforced at run time.
- Readers of the merged scope now name their permission: device lists and revocation, the sync
  token's `people_location_ids` (the narrowest of the three reads the location streams serve),
  handover whole views and staff views, urgent alert recipients, the weekly break-glass report,
  `/v1/me`'s `scope`, audit defaults, per-user limits and `personReachedBy` (`care.note.write`,
  by role or by a grant that was never revoked).
  A second permission on one record counts only where it reaches it: task completion, status
  changes, return checks, the task an entry completes, incident changes and manager answers.
- Database: no migration; every policy reads the narrowed `app.scope`. `app.holds_permission_at`
  was already per permission; the handover and device policies judge the reader by the request's
  scope and the staff shown by their own assignments, so none needed a change.
- Docs: ADR-0071, the ADR-0002 cross-reference, the permission matrix (generator text), platform.md
  PLAT-004 and tasks, the security checklist (V8), records of processing (A4 and the sync row),
  HZ-011 (cause, controls and tests), the sync stream claim notes, and a changeset release note.

**Route audit**: 186 handlers. 165 call `requirePermission` (directly or through a helper) before
`withTenant`, but three of those helpers read first: the document lookups (`GET
/v1/documents/{id}`, `/content`, `POST /v1/documents/{id}/signatures`) find the row and then
require `people.person.read` for a person's document. Of the 21 others, `POST
/v1/documents/{id}/versions` reads the row before requiring its category's permission, and `GET
/v1/tasks` and `POST /v1/tasks/{id}/transition` require nothing. These six relied on the old
merged scope and are the allow-list. `/v1/me`, notifications, form templates, rates, sync uploads
and device reports require nothing and run with scope `none` (own rows, reference data, or the
system's view where they write); the tenantless routes (memberships, sessions, JWKS, health) and
the operator console never reach `withTenant`.

**Human actions logged**: none. After merge, the release note asks Registered Managers to check
role bundles.

**Tests**: `packages/domain` 4,055, `packages/db` 384, `packages/contracts` 34, `apps/api` 628,
`packages/sync` 59, `apps/mobile` 871, `apps/web` 338, `packages/ui` 342, `packages/ui-native`
141, all passing locally (`pnpm turbo run test --force --concurrency=2`) and through
`scripts/ci-local.sh`.

## 2026-10-12: Data scope per permission, review round 1 (ADR-0071)

The security review found three Mediums and the clinical safety review four (no Highs), with
twelve lows. All are fixed on `fix/platform-scope-per-permission` as fast-forwards.

- Assigned and break-glass people (S-M1): `PermissionScope` gains `includesAssigned` (a role
  scoped to assigned people carries the permission) and `includesBreakGlass` (only
  `BREAK_GLASS_PERMISSIONS`: `people.person.read`, `care.plan.read`, `care.note.read`; H-168).
  `narrowestScope` ANDs them, `widestScope` ORs them. The request context, `inScopeOf` and
  `staffViews` set `app.scope_assigned` and `app.scope_break_glass`; migration 0049 makes
  `app.person_in_scope` honour them. Search, `permissionsReaching`, `personReachedBy` and the sync
  token follow. A break-glass record the read scope does not open is rolled back (L6).
- Places (L1, L2, L8): `organisation_wide` on `access_grant` and `role_assignment` (migration 0048
  marks existing rows); a check and a trigger refuse an unmarked grant or location role with no
  location; `app.holds_permission_at`, the domain, `holdsPermissionAt`, `permissionHolders`,
  `submitHolders` and `personReachedBy` honour the mark; one loader (`services/access-rows.ts`)
  reads roles and grants for the API. Restrictive policies limit giving grants and assigning people
  to where the member holds `platform.grant.manage` or `people.assignment.manage`.
- Sync (C-M1, L3): per-family claims (`people_*`, `care_*`, `entries_*` location ids and assigned
  flags); the deletion route decides on the manager check before its transaction.
- Documents (S-M2, L4, L5): category read permissions, per-category list scopes, a new version
  found again where the upload permission reaches before storing, bytes stored after the insert
  and destroyed on failure, HEAD judged as GET. Organisation documents stay readable by every
  member (policies staff follow), a deliberate departure from search's mapping.
- Audit trail (S-M3): whole only across the organisation; otherwise own events and events about
  reached people, without reasons. STATUS follow-up: `location_id` on audit events.
- Tasks (C-M3, C-M4, L10): `mayBeGiven` (people.person.read and the task permission must reach
  the person) on create and assign; escalation holders and fallback filtered by the person; a
  refused entry's urgent review told only to in-charge staff who hold its permission; holders must
  reach the task's place with `people.person.read`. New hazard HZ-073 (H-169) with a table-driven
  check of the routing role keys; HZ-014's control text updated.
- Domain checks (L7, L9): `usablePermissions` (MFA met; step-up kept so the domain can ask for a
  fresh sign-in) feeds `permissionsReaching` and the workflow, exit and admission guards, which
  now see only permissions reaching the person.
- Allow-list (L12): `route-gates.test.ts` scans the route sources for a scope gate before the
  database, with ten listed exemptions and its limits stated; `useScopeOf` refuses unlisted routes.
- Docs (C-M2, L11): the release note rewritten with its clinical safety changes, the
  pre-deployment access report (`docs/runbooks/data-scope-per-permission-access-report.sql`, read
  only), the DCB0160 deployer control, ADR-0071 review round 1, HZ-011 rows, `staffCanSee`'s
  docstring, specs and registers.

**Human actions logged**: H-168 (what break-glass opens, CSO and DPO), H-169 (HZ-073 rating, CSO).

**Tests**: `packages/domain` 4,069, `packages/db` 390, `packages/contracts` 34, `apps/api` 675,
`packages/sync` 62, `apps/mobile` 871, `apps/web` 338, `packages/ui` 342, `packages/ui-native`
141, all passing locally (`pnpm turbo run test --force --concurrency=2`, 0 cached) and through
`scripts/ci-local.sh`.

## 2026-10-12: Data scope per permission, review round 2 (ADR-0071)

No Highs. The clinical safety review found three new Mediums and one older one, the security
review two, with thirteen lows. All are fixed on `fix/platform-scope-per-permission` as
fast-forwards; three items are STATUS follow-ups.

- The nurse in charge (C2-M1): one definition (`nurseInCharge`, clinical leads and team leaders
  whose roles in force reach the home, else the Registered Manager) for urgent result alerts,
  care plan and risk review notices and refused-entry reviews, filtered only by what the recipient
  can see (`nurseInChargeSeeing`). An urgent refused-entry review tells the nurse in charge whose
  `people.person.read` and `care.note.read` reach the person and the `care.plan.write` holders
  who can see them, else the fallback, else audits `care.refused_entry.unrouted`. A home with
  team leaders and no clinical lead tells its team leader; the HZ-008 test asserts exactly who
  was told.
- Read only where the API refuses (C2-M2, C2-M3): `GET /v1/people/{id}` returns `access`
  (`recordCare`, `editCarePlan`, `readOnlyReason`); the notes, charts and body map pages, and the
  chart settings, offer their forms only when it allows and otherwise say why, in English and
  Welsh; the break-glass sheet says the record opens for reading only. The sync token carries
  `entries_write_location_ids` and `entries_write_assigned`; the phone keeps them
  (`harbour.write-scope.v1`) and offers recording only there. A Playwright journey opens a record
  by break-glass at a second demo home (Harbour Mews, web journeys only) and finds no form.
- Who is told by role (C2-M4, lows): `roleHolders` and `roleInForce` (assignment in force, role
  not archived, member invited or active, no location reaching everywhere only when scoped to the
  organisation or marked) for the overdue escalation, escalation chains, Registered Manager
  lookups, break-glass alert and weekly report recipients, the fallbacks and device-hold carriers;
  a fallback about no one prefers whoever reaches the location; `personReachedBy` checks the
  assignment and role windows together; a new round keeps its series' assignee only while they may
  be given it; `workLocationIds` gives `/v1/me` and the token the same work locations.
- Documents (S2-M1, low): signing a person's document needs the category's write permission
  reaching the person without break-glass; an organisation's document refuses a person and a
  person's subject type, and a person-category document with no person is not found.
- Grants with no location (S2-M2): migration 0048 stops, naming the count, while any is live. The
  access report lists narrows and widens for the record on screen and the three sync families,
  counts assigned people instead of naming them, and reads a tenant role assigned at a location
  as that location, as before.
- Other lows: the people sync family needs `care.plan.read` too; a refused break-glass attempt is
  audited after the rollback; `planTaskLink` and the return check honour step-up through the
  session's freshness; `assignment_change` has a `USING` expression; HZ-073 proposed at Major /
  Low / 3 with its own DCB0160 row, linked from HZ-011; the release note and runbook say how to
  check every device has synced.
- Follow-ups in STATUS: bounding grant and role assignment writes by the granter's own
  permissions; `withTenantWideScope` restoring the scope in a `finally`; recording a failed
  storage destroy for the retention sweep.

**Tests**: `packages/domain` 4,069, `packages/db` 393, `packages/contracts` 34, `packages/i18n` 48,
`apps/api` 684, `packages/sync` 62, `apps/mobile` 882, `apps/web` 349, `packages/ui` 342,
`packages/ui-native` 141, all passing locally (`pnpm turbo run test --force --concurrency=2` on
`118a916`, 0 cached) and through `scripts/ci-local.sh`.

## 2026-10-12: Data scope per permission, review round 3 (ADR-0071)

Security found no high or medium; clinical safety found four mediums. All are fixed on
`fix/platform-scope-per-permission` as fast-forwards, with the clinical and security lows.

- Every tab (C3-M1): `access.reaching` lists the permissions reaching the person without
  break-glass; `writeAccess` gates every write form on the record (notes, charts, body map,
  activities and visits, assessments, care plan and drafts, risk assessments, ReSPECT and advance
  care), each showing the read-only line instead, now worded for every service ("tell the person
  in charge of this shift or your manager", "record in it"). The Playwright break-glass journey
  visits every tab with axe.
- The phone per person (C3-M2): the sync token names the people the user is assigned to
  (`entries_write_person_ids`, up to 100), so a coordinator who is also a carer records about
  their clients; before the first token, recording is offered only with `care.note.write`; a held
  session clears the write scope.
- Escalations (C3-M3, C3-M4): an overdue task goes to first responders, then a Registered Manager
  reaching the home (there or across the organisation), then care plan holders who can see the
  person; with no one it is audited (`task.escalation_unrouted`), not marked escalated, and tried
  again after an hour. A chain step with no holder falls back to a Registered Manager reaching
  the home, else the owner; with no one it is audited (`platform.escalation.unrouted`). Only
  active staff are told (`TOLD`); invited stays eligible for access and assignment.
- Lows: urgent refused-entry notices prefer care plan holders at the home over those across the
  organisation; the refused-entry unrouted audit is tested; docs say team leaders are told at
  every home and no rota is checked; HZ-073 titles match and H-169 says both levels are 3; the
  device check gives its cut-off in Europe/London and lists staff whose phone was never seen;
  documents take an allow-list of organisation subject types and refuse a subject id without a
  type; the new-version route does not find a person-category document with no person;
  `roleInForce` and `accessRowsOf` check deleted roles and members, staff status and the
  organisation on every join; `workLocationIds` skips portal and mixed roles; a refused
  break-glass audit that fails is logged and still answers 404; `seed-users` needs
  `HARBOUR_SEED_DEMO_USERS=1`; the runbook covers environments that ran round 1's 0048 and never
  reactivating an organisation-wide grant without a decision.

**Tests**: `packages/domain` 4,069, `packages/db` 393, `packages/contracts` 34, `packages/i18n` 48,
`apps/api` 694, `packages/sync` 62, `apps/mobile` 886, `apps/web` 359, `packages/ui` 342,
`packages/ui-native` 141, all passing locally (`pnpm turbo run test --force --concurrency=2` on
`5f09cb1`, 0 cached) and through `scripts/ci-local.sh`.

## 2026-10-12: Data scope per permission, review round 4 (ADR-0071)

Security found no high or medium; clinical safety found one medium (C4-M1), fixed with the lows on
`fix/platform-scope-per-permission` as fast-forwards.

- Escalation needs someone other than the assignee (C4-M1): each tier leaves the assignee out;
  with no one else the assignee is reminded, the task stays at level 0 and
  `task.escalation_unrouted` (`assignee_only`, `no_one_sees_person`, `no_one_reaches_location`)
  is audited at most once a day, while a new hourly run (`task-escalation-retries`) retries the
  routing. A daily job (`unrouted-daily-report`) logs one `escalation.unrouted.daily` line per
  organisation with counts per unrouted audit action; the on-call runbook alarms on it. H-170
  asks the CSO whether the organisation needs an in-product signal too.
- Lows: a task about a person with no location takes the person's home (escalation and
  `POST /v1/tasks`); a break-glass alert no one active receives is audited and counted;
  `submitHolders` tells only active staff; above 100 assigned people the phone falls back to the
  location rule; a write scope the phone cannot keep is logged and fails closed; a tab says when
  two-step sign-in is the reason (`access.mfaRequired`), and the charts tab says why chart
  settings are hidden; the device check counts grant-only staff and ignores deleted, portal and
  mixed roles; a one-off check lists organisation documents outside the subject allow-list.
- Follow-ups in STATUS: future-dated assignments and the write claim; Playwright coverage of the
  draft plan page and the review, close, withdraw and correct controls.
- The round view tests in `rounds-and-handover.test.ts` create tasks due 5 to 15 minutes ahead,
  so between 19:45 and 20:00 London time (the default night shift starts at 20:00) they fall in
  the next shift and three tests fail; a run outside that window passes. Not changed here.

**Tests**: `packages/domain` 4,069, `packages/db` 393, `packages/contracts` 34, `packages/i18n` 48,
`apps/api` 700, `packages/sync` 62, `apps/mobile` 890, `apps/web` 360, `packages/ui` 342,
`packages/ui-native` 141, all passing locally (`pnpm turbo run test --force --concurrency=2` on
`6517b9d`, 0 cached) and through `scripts/ci-local.sh`.

## 2026-10-12: Data scope per permission, review round 5 (ADR-0071)

Security found no high or medium; clinical safety found three mediums (C5-M1 to C5-M3), fixed
with the lows on `fix/platform-scope-per-permission` as fast-forwards.

- The operator's alarms are infrastructure (C5-M1): `infra/modules/observability` has CloudWatch
  Logs metric filters on the worker's log group, `{ $.event = "escalation.unrouted.daily" }` (any
  line in a day) and `{ $.event = "worker.job.failed" }` (one or more in 15 minutes), each with an
  alarm to the alerts topic. Every worker job runs through `runJob`, which logs
  `worker.job.failed` (queue, error kind, database code) and throws on. The stack test asserts
  both alarms' wiring. Applying the Terraform is H-171.
- Every organisation is escalated when one fails (C5-M2): the minute run, the hourly retry and the
  daily report run through `eachTenant`; a test injects a failure in one organisation and sees the
  next escalate, with `platform.job.tenant_failed` audited. The daily report counts 25 hours.
- An overdue statutory notification no active member of staff can submit is audited
  (`safety.notification.unrouted`, `no_active_submitter`) at most once a day and counted (C5-M3).
- Lows: `access.mfaRequired` and its web line removed; the phone records about no one while its
  write scope is unknown and says to sync again, and keystore failures fail closed; a sync task's
  own assignee and a break-glass opener are not counted as told (`assignee_only`, `opener_only`);
  the unrouted audit is deduplicated by reason; the hourly retry takes every unrouted task in
  pages; a task about a person placed away from their home is refused (422); the charts tab's line
  is about entries above settings the viewer can change; HZ-073's verification table names the
  new tests.
- Follow-ups in STATUS: a per-recipient summary for overdue tasks; paging overdue statutory
  notifications; `materialiseTaskSeries` and `raiseCareReviews` through `eachTenant`.
- Terraform (the workflow's static job, run locally with Terraform 1.16.5 and TFLint 0.64.0): fmt,
  init and validate for dev, staging and prod, `terraform test` (7 runs) and TFLint for each
  environment pass. Trivy's configuration scan was not run locally.

**Tests**: `packages/domain` 4,069, `packages/db` 393, `packages/contracts` 34, `packages/i18n` 48,
`apps/api` 710, `packages/sync` 62, `apps/mobile` 891, `apps/web` 360, `packages/ui` 342,
`packages/ui-native` 141, all passing locally (`pnpm turbo run test --force` on `7077687`, 0
cached) and through `scripts/ci-local.sh`.

## 2026-10-12: Data scope per permission, review round 5 check (ADR-0071)

A short combined security and clinical check of the round 5 diff (`8346d20..67c3fdc`) found no
high. Clinical safety found one new medium: the unrouted alarm summed over a day, so with the
report running daily an organisation unrouted for weeks could hold the alarm in ALARM and hide
another organisation's first line (CloudWatch notifies only on a change of state). The alarm now
sums over an hour, so it clears within the hour after each daily run and every run with a line
notifies again; the stack test and the on-call runbook say so. The lows are STATUS follow-ups.
Hosted CI (now running, the repository being public) was green on `67c3fdc`.

## 2026-10-12: Hosted CI back, data scope per permission merged, sweep and test fixes

- The repository is public, so hosted CI runs again. Its first runs on `main` (`a375cf4`) were
  green on every job (lint, types, API contract, builds, gitleaks, Trivy, Syft, audit, unit, domain
  and RLS isolation tests, Playwright and axe, container image builds, CodeQL). Dependabot's
  commits are no longer held to the Harbour commit scopes (#29).
- Data scope per permission (#27, ADR-0071) merged after the round 5 check (see the entry above).
- `materialiseTaskSeries` and `raiseCareReviews` run through `eachTenant`, so one organisation's
  failure no longer stops the others' rounds or review tasks.
- The round view tests no longer fail in the quarter hour before a shift change (07:45 to 08:00
  and 19:45 to 20:00 London time), when tasks due a few minutes ahead fell in the next shift: the
  default view's test keeps its tasks inside the shift running now, a new test shows a task due
  after the shift ends only in a window that reaches it, and the other content tests read an hour
  either side of now. The task series and care review sweep tests check that no organisation's
  run failed, since `eachTenant` catches a failure (review round 1 of #30).
- esbuild in `apps/api` is on 0.28 (STATUS dependencies item).

## 2026-10-12: Slice 11 part 1, downtime pack and outage schema (OPS-028)

The first schema step for operations.md section 2, on the slice 11 domain rules. The back-entry
columns on the care events follow in part 2 (they reference `outage`), to keep this PR small.

- `downtime_pack` (append-only) and `outage` (mutable, versioned) with forced row-level security
  (migrations 0050 and 0051). A pack is visible only where the reader holds
  `operations.downtime.read` and can see every person on it; an outage to staff at its location,
  written only by holders of `operations.downtime.manage` there. Windows at a location never
  overlap; `app.outage_guard` keeps the window back-entries rely on and the workflow's order.
- Location settings `downtime.mar_location` and `downtime.peep_location` as two columns on
  `location`, seeded with the domain defaults.
- The export catalogue classifies both tables and the two columns (retention `downtime_pack` and
  `downtime_record`); data standards and records of processing add the cancellation and pack
  fields; HZ-011, HZ-017 and HZ-021 name the new database tests.

**Tests**: `packages/db` 406 (13 new in `downtime.test.ts`), `packages/domain` operations and export
tests passing locally.

## 2026-10-12: Slice 11 part 1, review round 1 (#32)

Security and clinical safety reviews of the downtime pack and outage schema. Fixed in migrations
0050 and 0051 (not yet on `main`, so edited in place):

- (M1) An outage is declared open by a trigger: nothing closed, reconciled, cancelled or corrected
  at declaration, `declared_at` is the database's time and `declared_late` is worked out from
  `care_note.late_entry_hours` (late when no figure is found); neither changes afterwards except
  the flag following a corrected start.
- (M2) A pack's `person_ids` are worked out from its content (pages and anyone left out), so the
  row-level security policy is never told less than the pack holds.
- (clinical M2) The MAR and PEEP places gain a confirmation (`downtime_places_confirmed_at`,
  `_by`); only holders of `platform.location.manage` change or confirm them; the HZ-021 control
  now claims only what is built (H-201).
- (clinical M3) An outage's start and end can be corrected before reconciliation with a
  `correction_reason` of their own, kept in the history (H-202).
- Lows: non-blank reconciliation statement and reasons; tests for non-holder and cross-tenant
  updates, owner delete and truncate of a pack, final cancelled outages and closed to cancelled.
- Logged: a pack hidden after a move (HZ-021, HZ-073, H-200, a planned part 3 test), pack PDFs
  kept out of `document`'s general view, and STATUS follow-ups.

**Tests**: `packages/db` 408 passing locally (15 in `downtime.test.ts`).

## 2026-10-12: Slice 11 part 1, review round 2 (#32)

Security closed M1 and M2. Clinical safety found one new medium: a pack's `person_ids` took in the
content's `excluded` people (another location's, former residents), hiding the pack from every
location-scoped nurse in charge. Now `person_ids` comes from the pages only; the stored content
names no one left out, holds only the pack's own keys and warnings about its own people; the
`warnings` column holds counts only; and a pack with no pages is refused while anyone is receiving
care at the location. H-202 notes that a narrowing correction can drop entries from the duplicate
review; three STATUS follow-ups.

## 2026-10-12: The consent, capacity and DoLS tab, part 1 (slice 9, Lane B)

The web record gains an eleventh tab, "Consent, capacity and DoLS" (`/people/{id}/capacity`,
`care.plan.read`), on the API already on `main`: whether a valid consent is in place now for each
decision, with the capacity found for it, and the DoLS register with each authorisation's clock in
words and UK dates, its reminders, CQC notification and legal-change review state, and a link to
its history (the web history page now opens DoLS authorisations). Statuses are icon and word; an
unknown one is a warning (HZ-020, HZ-026). No API, schema or permission change. The capacity
assessments, best-interests decisions, consent records and the forms are the next part (STATUS
item 13); two API gaps are in care.md section 10.

**Tests**: `apps/web` 378 unit (18 new in `src/lib/mca.test.ts`), `packages/i18n` 48; Playwright
`e2e/capacity.spec.ts` (records through the API as the demo nurse, then reads the tab, with axe in
both themes and on the DoLS history) and the existing record journeys with the new tab, run
locally.

## 2026-10-12: The consent, capacity and DoLS tab, review round 1 (#34)

Accessibility and clinical review of part 1. Every reason, CQC line, type, outcome and review
state is now in the catalogue's words (en-GB and Welsh), with no internal or roadmap names; an
unknown value warns. Consent: "Refused" is a warning that says who refused, nothing recorded reads
"No consent recorded" with the next step, and each decision shows the date of the capacity
finding and its review date. DoLS: a midnight end reads as the last day in force and the days
count to it; a renewed authorisation reads "Renewed"; one from before the June 2026 judgment with
no review warns with the next step; each authorisation and its history link are named with the
date; dates are in `<time>` elements; the history link is 44 px; long references wrap.
`/people/{id}/dols` (the expiry alert's link) opens the tab. Human actions H-250 to H-253 for the
CSO; STATUS item 14 for the follow-ups.

**Tests**: `apps/web` 388 unit (31 in `src/lib/mca.test.ts`), `packages/i18n` 48; Playwright
`e2e/capacity.spec.ts` (every warning state, the alert link, axe in both themes, keyboard to the
history link with its focus ring, 320 px, the empty tab), run locally.

## 2026-10-12: The round and the handover on the phone, streams (slice 10 part 2, Lane C)

First of three pull requests for tasks and handovers in Care mode
(`feat/mobile-tasks-handover-sync`).

- Sync streams (`packages/sync/src/streams/sync-config.yaml`): `assigned_open_tasks` and
  `location_open_tasks` carry the open tasks due on a day of the offline window, scoped as the
  round view (`care.plan.read`, `app.task_visible`); `assigned_handovers` and
  `location_handovers` carry the handovers of shifts ending in the window with the items, notes
  and acknowledgements the handover views show (`care.handover.manage`). Limited readers get only
  their people's items and notes, the handover's own notes and their own acknowledgements; items
  about a person carry no status filter, as row-level security has none (HZ-018). No task details
  or reasons, handover refresh time, version or device ids reach a device.
- The sync token carries `handover_location_ids` and `handover_assigned` (`familyReach` for
  `care.handover.manage`), audited with the other families; the device schema gains `task`,
  `handover`, `handover_item` (`key` as `item_key`), `handover_note` and
  `handover_acknowledgement`, read-only.
- Isolation through the real sync-rules engine (`task-handover-streams.test.ts`, 16 tests):
  scopes, ended assignments, moved and deceased people, items about nobody, acknowledgements,
  each family only with its own claims, two tenants, hostile connection parameters, no window or
  tenant. Hazard log rows on HZ-011, HZ-018 and HZ-028; care.md section 6, records of processing
  and data standards updated.
- Needs a migration before anything syncs (Lane A): the five tables join the `powersync`
  publication with the sync role's read policy and grant. Next: the offline completion and
  acknowledgement, then the screens (STATUS item 13).

**Tests**: `packages/sync` 79, `apps/mobile` 891, and in `apps/api` the sync family, scope per
permission and API suites (128), passing locally; typecheck clean for sync, API and mobile.

## 2026-10-12: The round and the handover on the phone, review round 1 of #33

- Security M1: other members' acknowledgements no longer carry their item keys (which name the
  people and what happened to them). Each reader gets their own acknowledgements with keys; a
  whole reader gets who acknowledged and when in a new device table,
  `handover_staff_acknowledgement` (a renamed output of `handover_acknowledgement`). Fixtures use
  real keys (`kind:sourceType:sourceId:personId`), and a test proves a moved resident's keys in
  a nurse's acknowledgement never reach the manager's phone.
- Security L1 and L3: a limited reader's items, notes and own acknowledgements come only from
  handovers they may open (joining `person_assignment` twice: one to open the handover, one for
  the item's person), so nothing the API refuses reaches the phone; a reader whole at one home
  and assigned elsewhere gets, in the homes they see whole, the items about their people who
  have moved, as the API shows them. Mixed-scope and hostile-parameter tests cover items and
  notes.
- Clinical M1 to M3 and lows: `locked_at` and the shift bounds say not final; the hazard rows
  claim only what is built and are marked not yet live until the publication migration; HZ-024
  gains a planned phone control; task titles are free text (3 to 120 characters) in the schema
  and data standards. The screens gate, CSO questions H-300 to H-304 and three follow-ups are
  in STATUS item 13 and care.md section 6.

**Tests**: `packages/sync` 81, `apps/mobile` 891, passing locally; typecheck clean for sync and
mobile.

## 2026-10-12: The round and the handover on the phone, offline writes (slice 10 part 2, Lane C)

Second of four pull requests (`feat/mobile-offline-round-writes`, stacked on #33); no screen yet.

- A task is marked done, or not done with a reason, on the device: checked with the API's own
  rules (`checkTaskTransition`), written on the synced row with the move in `queued_transition`
  (its own UUIDv7 and the version seen) only while the row is the open task the carer saw. A
  task that needs evidence is done by recording the entry it asks for, which now carries
  `task_id` and is sent as `taskId`.
- A handover is acknowledged on the device as a new row with the seen token worked out over the
  items shown, exactly as the API does (tested against its algorithm).
- HZ-018 test row; care.md section 6 and data standards updated.

**Tests**: `apps/mobile` 910, `packages/sync` 81, `packages/i18n` 48, passing locally;
typecheck clean for mobile and sync.

## 2026-10-12: The round and the handover on the phone, offline upload (slice 10 part 2, Lane C)

Third of four pull requests (`feat/mobile-offline-round-upload`, stacked on the writes).

- The connector sends a task's move to `POST /v1/tasks/{id}/transition` and an acknowledgement
  to the handover's acknowledgements route, each with the entry headers; care entries and these
  share one request path.
- A refusal moves it to "needs attention" with what the carer did, in the phone's words for a
  task changed first or a handover changed since it was read; a 409 on a move whose answer was
  lost counts as sent when the task list shows it made by the same member of staff (HZ-029).
- Hazard rows on HZ-006, HZ-018 and HZ-029; care.md section 6; a STATUS follow-up on dismissing
  a refused move or acknowledgement.

**Tests**: `apps/mobile` 924, `packages/i18n` 48, passing locally; typecheck clean for mobile.

## 2026-10-13: The round and the handover on the phone, offline writes, review round 1 (#36)

- Security M1: a task's move is offered only where the server would take it (a task given to
  the member, or one about a person naming `care.note.write` where the write scope reaches
  them), never while the member or the scope is unknown; one acknowledgement waits per
  handover and member.
- Clinical M1: a move or acknowledgement held when a session ends goes back into the queue
  for its owner after sign-in, as entries do, and is never sent by another member in a
  hand-over; held moves are kept under their own id.
- Clinical M3 and M4: the evidence copy says the task completes when the entry uploads;
  screens gate item (f); HZ-006 and HZ-029 rows, with hazard ids in the tests' names; the
  module no longer claims what the upload does.
- Logged: H-305 to H-308 for the CSO and DPO, and five STATUS follow-ups. A task's time of
  care from the phone waits for task columns, a late label, a lower bound and a handover rule
  (#41 closed): an HZ-017 row, a STATUS follow-up and H-309; the completion stays recorded
  when the move arrives.

## 2026-10-13: The round and the handover on the phone, offline writes, review round 2 (#36)

- Merged `main` (#33, #39 and #40), keeping both sides of the shared documents.
- Logged the five round 2 lows as STATUS item 15 follow-ups: the person's home looked up
  inside `useMoveTask`; the bare task row a held move is put back on, and its PUT; held round
  changes re-queued only for their owner; "already waiting to upload" after a refused
  acknowledgement; "tell the person in charge" shown to nurses.

## 2026-10-13: The round and the handover on the phone, publication migration (#33)

- Migration 0052 adds `task`, `handover`, `handover_item`, `handover_note` and
  `handover_acknowledgement` to the `powersync` publication, with the `sync_replication_read`
  policy and `SELECT` (only) for `harbour_sync`, as 0012 and 0017 do.
- `packages/db/test/sync-publication.test.ts` reads the source tables of every stream query and
  checks each is published and readable by the sync role, and that the sync role holds nothing
  but `SELECT` on the five tables.
- The hazard rows for the streams now name the migration and the test. Round 2 of #33: screens
  gate item (e) (the phone must be able to say the outgoing handover is not compiled yet or not
  final, which needs the expected shift on the device; H-303), the alias caveat in H-304, and a
  STATUS low for a carer assigned to two people at different homes.

**Tests**: `packages/db` 411 (real Postgres), `packages/sync` 81, `apps/mobile` 891, passing
locally; typecheck clean for db, sync and mobile.

## 2026-10-13: The round and the handover on the phone, uploading, review round 1 (#37)

- Security M1 and clinical M1: a move refused because the task changed (409) reads the task
  (`status=any`, narrowed to the move's person or the task's home and its due time). Only an
  answer it can read decides; anything else keeps the move queued, and an ended session ends
  it. The carer's own move counts as made only at the next version, by them, with their
  reason; a task nobody closed gets the move once more; otherwise the words say what
  happened (done, not done, cancelled, changed).
- Clinical M3: a move kept without its person is named by the person in the move and shows
  on their screen; a move put back on its task's row after a session ended is sent.
- Item 8: the move does not send its time of care (#41 closed); the completion is recorded
  when the move arrives, and the device time stays on the phone (H-309).
- A move whose follow-up check keeps failing is parked after 5 failed reads or 30 minutes,
  with its data and words saying it could not be checked, so care entries behind it upload.
- HZ-006 and HZ-029 rows; a STATUS follow-up that round refusals do not ask for a server
  copy.

**Tests**: `apps/mobile` 977, `packages/i18n` 48, passing locally; typecheck clean for
mobile.

## 2026-10-13: The round and the handover on the phone, uploading, review round 2 (#37)

- Medium: a move refused with a 409 is never sent again, even to a task still open, because a
  task's version also moves when more is added to it (a review task's entries), so a stale
  "done" could close what the nurse never saw. The words are true of the task: still open, it
  changed after you marked it (`task_changed`); done or not done by someone else, or cancelled,
  what happened; in your name but not as this move, it could not be checked; not in the list, it
  could not be found (`task_not_found`). The lost-reply check stays. H-310 and a STATUS
  follow-up for a content version that would make a resend safe; H-305 updated.
- N1: only reads the server refused count towards the cap; no network, a timeout or a 5xx keeps
  the move queued however long it lasts (tested with the real backoff).
- Lows: a move that cannot be sent is kept under its own id and tenant when they can be read
  (STATUS says why not otherwise); the cap's count is cleared when the session ends.

**Tests**: `apps/mobile` 981, `packages/i18n` 48, passing locally; typecheck clean for mobile.

## 2026-10-13: The round and the handover on the phone, uploading, confirmation check (#37)

- A 5xx or 429 on the task read starts the 30-minute clock without counting towards the 5
  reads, so a fault in that one route parks the move after 30 minutes and the entries behind it
  upload, while a short outage parks nothing. A 401 on any upload ends the session through the
  same path, clearing the check counts.
- STATUS: screens gate item (g), the needs-attention screen with or before the round screen;
  follow-ups for an unchecked 403 on the task read, the `task_unchecked` wording for a closed
  task, and the alert-fatigue risk with no resend.

**Tests**: `apps/mobile` 984, passing locally; typecheck clean for mobile.

## 2026-10-13: The consent, capacity and DoLS tab, part 2 (slice 9, Lane B)

The rest of the tab's read views, on the API already on `main` and held to the standards of #34's
review round 1: capacity assessments with the two-stage answers, the outcome in the Act's words,
the review date and corrections struck through; best-interests decisions with the section 4
checklist, the people consulted and the IMCA prompt as a warning in the catalogue's words; and
consent records saying whether each decides its decision now, a refusal as a warning, the
representative's authority, the capacity it was made under with the assessment's date, and a
history link named with the decision and date (the web history page now opens consent records).
No API, schema or permission change. The forms are next (STATUS item 13).

**Tests**: `apps/web` 401 unit, `packages/i18n` 48; Playwright `e2e/capacity.spec.ts` (three
journeys, with axe in both themes) and `e2e/care-record.spec.ts`, run locally on a fresh scratch
database set up as the CI e2e job does.

## 2026-10-13: The consent, capacity and DoLS tab, part 2, review round 1 (#35)

Accessibility and clinical review of the capacity assessment, best-interests and consent record
views. An older capacity finding that a later assessment of the same decision replaces says so
and has no overdue review; a best-interests decision says what its assessment found and warns
when it was corrected or overtaken; the finding is worded from the two stages in the catalogue,
not the API's English; consent records warn when the deciding record was withdrawn or expired,
or cannot be placed, and say when one starts later. The journey records every consent state,
both representatives with their authority, the corrected best-interests decision and the later
assessment before its axe and 320 px checks, and opens the earlier version by keyboard. Human
actions H-254 and H-255 for the CSO; STATUS item 16 for the follow-ups.

**Tests**: `apps/web` 410 unit, `packages/i18n` 48; Playwright `e2e/capacity.spec.ts`,
`care-record.spec.ts` and `break-glass.spec.ts` on a fresh scratch database, run locally.

## 2026-10-13: OpenFeature provider over the flag catalogue (Lane D)

- Flags go through an OpenFeature provider (`@openfeature/server-sdk`, Apache-2.0;
  `apps/api/src/flags`): the organisation's location row, then tenant row, then Flagsmith, then
  the catalogue. Flagsmith is used only when its key is set (production requires https on the
  environment's own flags host), sees opaque ids only, may set only the flags marked `remote`
  (the workforce module and the public site; never AI, clinical or data-protection modules,
  clinical tools, review workflows or language) and falls back to the catalogue when it does not
  answer, asking at most once per identity per cache period; a provider error keeps the
  organisation's own rows (#39 review round 1). `/v1/me` uses the provider and now leaves out
  deleted rows.
- Human action H-352 (Flagsmith key in the API task once H-13 is decided). Tests: the domain's
  table-driven order (`rules.test.ts`), the provider and Flagsmith unit tests
  (`apps/api/src/flags/provider.test.ts`) and `apps/api/test/flags-and-sessions.test.ts`.

## 2026-10-13: Admin sign-out and idle timeouts per role (Lane D)

- `POST /v1/members/{tenantUserId}/sessions/revoke`: a holder of `platform.user.manage`, with
  step-up and a coded reason, signs a member out of every device (sessions are identity-level, so
  every organisation too); audited; a location role reaches only members wholly at its homes;
  entries waiting on the member's devices need confirming first (409 `entries_waiting`).
- Browser sessions are signed out after their role's idle timeout from the rate table
  (`session.idle_timeout_minutes[.<role>]`: 30 minutes, 15 for the owner and group executive;
  the strictest of the member's roles); mobile sessions never (HZ-110). The session middleware
  moves the expiry on hourly itself, with Better Auth's refresh off there, so a refresh never
  counts as use. No migration: the rows are seeded from rates.md, and no new permission.
- Hazard HZ-110; human actions H-350 and H-351. Tests: `sessions.test.ts` (domain, table-driven)
  and `apps/api/test/flags-and-sessions.test.ts`; the API suite passes.

## 2026-10-13: #40 review round 1 (Lane D)

- The browser idle timeout ships off (`SESSION_IDLE_TIMEOUT`, refused in production) because
  signing out mid-entry loses the form: new hazard HZ-111 with its planned controls, and H-353 for
  the CSO and DPO; the security review's bypasses are listed in platform.md as prerequisites for
  turning it on. A missing or invalid timeout figure falls back to the default and is kept between
  a floor and a ceiling (rate table), never a 500.
- The admin sign-out refuses a member who also works for another organisation (409, H-354),
  writes its audit row before ending the sessions and audits every refusal by opaque id, says that
  the phone loses its care record until the member signs in again, and for `staff_left` or
  `suspended` chases the holds on their devices as a revocation does. HZ-110 claims only what is
  built.

## 2026-10-12: Slice 11 part 2, back-entry columns (OPS-028)

Stacked on #32. Migration 0053 (numbered after Lane C's 0052):

- Expand-only back-entry columns on `care_note`, `observation`, `body_map_mark`,
  `activity_record` and `visit_log`, empty on every existing entry, with a CHECK tying them
  together and a composite reference to `outage` (which gains its `(tenant_id, id)` key).
- An entry names only an outage at its own location that was not cancelled (`entry_outage_guard`).
- `outage_guard` refuses to cancel an outage once a back-entry cites it, and a reconciler who
  entered any of its back-entries, both counted in the organisation's view and giving the caller
  their own view back.
- The export catalogue describes the eight columns on each of the five entries.
- (#32 review round 2) A correction of an outage's start or end may not leave a back-entry with
  no reason for being outside the outage outside it.

**Tests**: `packages/db` 416 passing locally (8 new in `back-entry.test.ts`).

## 2026-10-13: Slice 11 part 2, #38 review round 1 (OPS-028)

Migration 0053, edited in place:

- A back-entry against a reconciled outage is refused, as against a cancelled one; the outage is
  read again locked for share, so a cancel or a reconciliation at the same moment waits for the
  entry and then counts it.
- A back-entry's time is the instant its paper date and time give in UK time
  (`app.paper_instant`: the occurrence chosen in the repeated autumn hour, `only` refused there,
  the skipped spring hour refused).
- The outage window is `[start, end)`, an open outage running to now plus the clock-drift
  allowance: a back-entry outside it needs a reason, an entry not from paper names only an outage
  it falls in, and the window is checked whenever the start or end changes, closing included.
- A correction of a back-entry carries its paper details, or must stay on the same outage;
  superseded entries do not count for the cancel and window checks; the reconciler must not be
  the author or sender of an original back-entry.
- Docs: operations.md section 12 (part 2 after round 1, part 3 requirements), the HZ-017 rows,
  H-203 to H-206, STATUS follow-ups.

**Tests**: `packages/db` `back-entry.test.ts` now 17 (9 new), including the race between an entry
and a cancel.

## 2026-10-13: Slice 11 part 2, #38 review round 2 (OPS-028)

Migration 0053, edited in place:

- An entry citing an outage, a back-entry or one not from paper, can be corrected after the
  outage is reconciled, keeping the link (only new entries citing it are refused there); a
  back-entry is corrected once, a further correction superseding the correction (a partial unique
  index on each of the five entries).
- The reconciler check counts as a correction only an entry whose original is a back-entry of the
  same outage, and a correction cannot make an entry not entered from paper a back-entry.
- Closing may set the true end before back-entries already entered; reconciliation then waits
  until each one outside the window with no reason is in the reviewed entries (H-207). A
  correction of the start or end is refused only when it leaves out an entry that was inside.
- Docs: operations.md section 12, the HZ-017 rows, H-207 and H-208, STATUS on the clock-drift
  override and the reason a correction past the end needs.

**Tests**: `packages/db` `back-entry.test.ts` now 22.

## 2026-10-13: Invitations and MFA enrolment, spec and rules (Lane D)

- platform.md gains "Invitations and MFA enrolment": invite (step-up, reach, one pending link per
  member, a 256-bit token kept only as a hash, `invitation.expiry_hours` from the rate table),
  open, accept once (a new sign-in only where none exists for the address; never setting the
  password of an existing account), enrol a passkey or authenticator app before any care record,
  revoke and list; and the schema asked of migration 0054.
- `packages/domain/src/platform/invitations.ts` with table-driven tests: state, expiry, who may be
  invited, acceptance refusals and the path to a sign-in. API test: no one-time code by SMS or
  email (`OTP_NOT_CONFIGURED`).
- Data standards, records of processing and retention list the planned `invitation` rows;
  human action H-355. Blocked on migration 0054 for the store and routes.

## 2026-10-13: #43 review round 1, invitations (Lane D)

- The link carries its token only in the URL fragment; the page sends it in POST bodies, so it
  is in no load balancer or web log (M1). Lookup and acceptance are security-definer functions
  under their own NOLOGIN owner role, taking the raw token, locking the row and checking the
  sign-in's email and the organisation's status inside; the app role cannot read stored hashes
  (M2). An inviter must hold every permission of the member's roles (`permissionsBeyondInviter`,
  table-driven); the address is copied by the database and a change to the member revokes open
  links; an operator may invite only a first owner, through a definer function (M3). The address
  is cleared when an invitation is accepted, revoked or lapses, and invitations have their own
  retention class (M4).
- Lows: lapsed invitations are swept nightly (and freed for a new one), `invitation.expiry_hours_max`
  caps the expiry, lookups and acceptances are throttled per client address and token, the
  invitation is locked before a sign-in is created and the sign-in deleted on failure,
  `signedInAlreadyMember` is required, and members are never invited without MFA. M5 (MFA counted
  when enrolled rather than used) follows in its own PR.

## 2026-10-13: #43 review round 2, invitations (Lane D)

- N1: a revocation names its reviser, except, with no reviser and only through the definer
  owner's functions, the nightly sweep of lapsed invitations, the member-change trigger (so worker
  jobs with no member still clear the address) and the first owner's re-invitation; acceptance
  happens only inside `accept_invitation`. N2: an invitation's sender is always the session's
  member; `created_by_operator` only inside `invite_first_owner`, which the application role
  cannot imitate.
- Lows: `invite_first_owner` reads the expiry from the rate table and the operator from the
  session; the definer owner's grants listed (a column grant on `auth.user` of id and email only);
  throttling counts tokens by hash; a nightly sweep of unlinked sign-ins older than
  `invitation.unlinked_sign_in_hours`.

## 2026-10-13: The incident screens, part 1: the list and an incident (slice 9)

- An Incidents item in the sidebar for holders of `safety.incident.read`, and the list of
  incidents for the chosen location, newest first: each named by its type and time, with its
  status as an icon and a word, the questions still to answer and whether part of it is hidden
  from the reader.
- An incident page: what happened, with severity and harm as staff judged them; who was told;
  and the people on it. A reader who cannot see everyone on it is told part of it is hidden
  (HZ-013). The statutory notifications on the page follow in part 2.
- Words come from the catalogue (en-GB, with the Welsh copy marked untranslated). No API change;
  the gaps are in safety.md section 5 and STATUS item 19.

**Tests**: `apps/web` 396 unit, `packages/i18n` 48; Playwright `e2e/incidents.spec.ts`,
`care-record.spec.ts` and `capacity.spec.ts` on a fresh scratch database, run locally.

## 2026-10-13: The incident screens, part 1, review round 1 (#42)

Accessibility and clinical review of the incidents list and an incident's read view. The
incident page shows the questions about statutory notifications still to answer as a warning
chip, says when notifications are not checked yet or outside England, and says it does not show
the questions or notifications yet (HZ-013; H-256 for the CSO). A restricted reader sees "About
this incident" with a notice that says what they see, and "You cannot see the people on this
incident" when they see none. Each person we support shows their communication needs. When the
API's limit of 500 is reached the list fetches the open and under-review incidents besides and
says older ones are not listed. The page title names the incident by its date; a hidden location
reads "Location not shown to you"; the empty list reads "No incidents you can see". The journey
adds closed and under-review incidents, the empty list and the questions on the page; STATUS
item 19 logs the follow-ups.

**Tests**: `apps/web` 425 unit, `packages/i18n` 48; Playwright `e2e/incidents.spec.ts` on a
fresh scratch database, run locally.

## 2026-10-13: The incident screens, part 2: the notifications on an incident (slice 9)

- The incident page shows each statutory notification with its clock as an icon and a word
  (overdue first, then the soonest due, then done), when it is due, its recipient and its
  warnings: provisional, no longer indicated (only that, though the API keeps the draft
  provisional) and a Harbour target rather than a legal deadline.
- Questions still to answer, the kinds waiting for them, "not checked yet" and "not checked
  outside England" warn; "no notification found" only when nothing is open (HZ-013).
- Kinds and recipients come from the catalogue, checked against the domain's
  `NOTIFICATION_KINDS`. No API change; the gaps are in safety.md section 5 and STATUS item 19.

**Tests**: `apps/web` 434 unit, `packages/i18n` 48; Playwright `e2e/incidents.spec.ts` on a
fresh scratch database, run locally.

## 2026-10-13: The incident screens, part 2, review round 1 (#49)

Clinical and accessibility review of the notifications on an incident. "No notification found"
now also needs no outputs and no open check that decides one (RIDDOR's absence check, the
safeguarding decision guide, an outbreak's links, the candour decision), each said with its date.
Warnings show only on drafts still open, each with a next step; one waiting for answers says so.
Deadlines are in the law's terms ("Without delay: the clock started ...", RIDDOR's second
deadline), an overdue clock says for how long, and an overdue chip at the top links to the
section, which now comes before the people. Draft and ready are chips; not required uses the
not-applicable style; notifications about one person name them. A component test draws every
state with axe-core. Hazard log: HZ-013 control and verification, an HZ-008 assessment, HZ-001
and HZ-009 rows; human actions H-256 (restated) to H-260; STATUS item 19 follow-ups.

**Tests**: `apps/web` 459 unit (with the component test), `packages/i18n` 48; Playwright
`e2e/incidents.spec.ts` on a fresh scratch database, run locally.

## 2026-10-13: The incident screens, part 2, review round 2 (#49)

The overdue chip is a native link to the notifications' heading, which takes focus, so the
keyboard lands there (WCAG 2.4.3); the journey opens it by keyboard. Checks that decide a
notification are left out once the incident is closed, and once their date has passed read
"Check whether this was done: ..." (the stored tasks never clear; H-259 corrected). Candour's
spoken step counts from when the clock started; the written target reads "Harbour's target by";
the check lines carry their time; RIDDOR's threshold is looked up by the UK date; unknown clocks
count in the overdue chip. H-257 adds candour and RIDDOR's time of day; STATUS item 19 logs the
round's follow-ups.

**Tests**: `apps/web` 462 unit (with the component test), `packages/i18n` 48; Playwright
`e2e/incidents.spec.ts` on a fresh scratch database, run locally.

## 2026-10-13: Invitations, migration 0054 (Lane D)

- `invitation` (forced row-level security; the app role inserts its member, link, expiry and
  sender only, cannot read the hash, revokes only, never deletes) and the NOLOGIN role
  `harbour_invitation_owner`, held by `harbour_owner` with SET but not INHERIT. Definer functions:
  lookup, claim (locks), the sign-in record, acceptance (checks the sign-in's email), the first
  owner's invitation (expiry from the rate table, the operator from the session), the member-change
  trigger, the lapsed-invitation sweep and the narrow unlinked sign-in list.
- Database tests: sender rules (round 2 N2), coverage of the member's permissions (M3), the
  operator path, single-use acceptance, revocations with no reviser (N1: the sweep, a worker-style
  status change), and the unlinked sign-in list leaving other sign-ins alone. Database 450, API 737,
  domain 4,159 passing.


## 2026-10-13: #48 review round 1, invitation store (Lane D)

- H1: the unlinked sign-in sweep never lists a sign-in that any membership row names, in any
  organisation and any state (`app.auth_user_has_membership`, a yes-or-no definer owned by
  `harbour_membership_reader`), or an operator's; and `record_invitation_sign_in` records only a
  sign-in at the invitation's address created after the invitation.
- M1: the sign-in is recorded in its own committed transaction before the acceptance's, so it
  survives a rollback and the sweep can find it. M2: the database refuses an expiry past the global
  `invitation.expiry_hours_max`; an organisation's figure never raises it. M3: member-change
  revocations, the first owner's superseded invitation and the recorded claim are audited.
- Found by the new per-role test: `EXECUTE` on the definer functions was still open to `PUBLIC`,
  because `harbour_owner` (holding the owner role without INHERIT) could not revoke once ownership
  had moved; the grants are now set before the change of owner.
- Lows: the first owner's invitation checks the organisation's status and takes only a live owner
  role; a member revokes only as revoked or superseded; `clock_timestamp()` for expiry; an MFA
  requirement change revokes; deleted members refused; callers' settings restored; no address
  update grant; narrower column grants for the definer owner; the SET-not-INHERIT membership
  asserted. Database 470, API 737, domain 4,159 passing.

## 2026-10-13: Slice 11 part 3a-1, downtime pack API (OPS-028)

Stacked on part 2. `GET` and `POST /v1/locations/{id}/downtime-pack` (operations.md section 13):
the latest pack the reader can open, built again on the spot when it no longer serves the people
receiving care there, with the freshness words and header lines worked out now; shared allergy,
communication and rate helpers; unconfirmed MAR and PEEP places print as not set.

**Tests**: `apps/api` 4 new in `downtime.test.ts`; HZ-021's planned API test now passes.

## 2026-10-13: Slice 11 part 3a-2, the printed downtime pack (OPS-028)

Stacked on part 3a-1. `GET /v1/locations/{id}/downtime-pack?format=pdf` (operations.md section
13): the pack printed with the header worked out now on every page, a front sheet of warnings and a
page per person whose footer names them; the PDF is never stored. The PDF writer gains a header on
every page, page breaks and a footer naming whose page it is (HZ-001).

**Tests**: `apps/api` 1 new in `downtime.test.ts`, and printing in the audit test.

## 2026-10-13: Slice 11 part 3b, nightly packs, rebuilds and places (OPS-028)

Stacked on part 3a-2 (operations.md section 13): the nightly job (hourly catch-up, once per
location and UK night, each location in its own savepoint); a system rebuild after people
lifecycle events (`server_rebuild`, migration 0055) at both the old and the new location; `PUT
/v1/locations/{id}/downtime-places`, confirmed by a holder of `platform.location.manage`, with the
task the nightly job keeps open while the places are unconfirmed.

**Tests**: `apps/api` 2 more in `downtime.test.ts` and the places route in a third.

## 2026-10-13: Slice 11 part 3a-1, review round 1 of #45 (OPS-028)

- A stored pack is served only while nothing it was built from has changed since its information's
  time, now the database's clock (H1): a new DNACPR, allergy or room swap means a new pack.
- One build at a time per location; a POST reuses the pack when nothing changed and needs a fresh
  sign-in; a per-member limit from `downtime_pack.requests_per_hour` (security M1, M2).
- A failed rebuild serves the latest pack, saying so, audited (clinical M1); during an outage,
  "anything recorded since" is the earlier of the information's time and the outage's start
  (clinical M2).
- A location out of reach is audited as denied; allergies are each person's own current ones, as
  on the phone (`currentAllergiesOf`, also used by the hospital transfer pack); the four copies of
  `rateRows` are one.
- Docs: operations.md sections 12 and 13, rates.md, HZ-007, HZ-015 and HZ-021 rows, H-209 and
  H-210, STATUS follow-ups.

**Tests**: `apps/api` `downtime.test.ts` 11 (7 new); `packages/domain` 1 new.

## 2026-10-13: Slice 11 part 3a-2, review round 1 of #46 (OPS-028)

- Printing needs a fresh sign-in and counts against the per-member limit before the pack is read
  (security M2, M3); the printed audit is written once the PDF is drawn; HEAD is refused.
- Every person's page says to confirm who they are with a colleague who knows them, and the front
  sheet says photos are not printed (clinical M3, H-211); an ADRT held prints "ADRT also held:
  read it before any decision about resuscitation" and is never read as nothing recorded
  (clinical M4, H-212).
- Header times carry BST or GMT on a clock-change day (HZ-009); "1 person" is singular.
- Docs: operations.md section 13, HZ-001, HZ-015 and HZ-021 rows, H-211 to H-213, STATUS.

**Tests**: `apps/api` `downtime.test.ts` 3 new and printing in the step-up test; `packages/domain`
4 new.

## 2026-10-15: Slice 11 part 3b, review round 1 of #47 (OPS-028)

- A bed move publishes `people.person.moved` and rebuilds both locations' packs (H2); a places
  change rebuilds the location's pack.
- Outbox handlers of one event run on their own; a failed rebuild is logged by opaque ids and
  never holds back the death notification (clinical M5); after the nightly run a location with no
  pack in date raises a task for its Registered Manager.
- The places task is raised after the build in its own savepoint, due at the end of the day
  `downtime.places_confirm_due_days` from now; the places route takes the location's version,
  refuses a deleted location and completes the task through the task workflow.
- Migration 0055 also refuses a pack naming a stored document.
- Docs: operations.md section 13, rates.md, HZ-021 rows, H-214, STATUS.

**Tests**: `apps/api` `downtime.test.ts` 2 new and 2 rewritten; `packages/db` 1 new.

## 2026-10-16: Slice 11 part 3c, the outages API (OPS-028)

Stacked on part 3b (operations.md section 13): list and declare outages at a location, close one
with the back-entry task, see what reconciling needs, reconcile after reviewing possible duplicates
and back-entries past the true end, cancel one declared in error, and correct a start or end; each
change versioned, audited and, where section 5 says so, published; the database's refusals in its
own words. Merged with main; `openapi.json` and the client regenerated (the outage paths only).

- Docs: operations.md section 13, the HZ-017 test row, H-215, STATUS (the outside-the-outage
  reason on a back-entry correction moves to part 3d, with the care routes).

**Tests**: `apps/api` `outages.test.ts`, 5 new.

After #51 review round 1: an outage declared with its end closes at once with the back-entry task;
`downtime.max_outage_hours` (168, rates.md) bounds an outage's length; corrections stay within
the closure plus the clock-drift allowance; outages are locked before each change; cancel and
correct are published; another home's outage is not found and audited as denied; the reconciliation
selects only the columns it needs; `withTenantWideScope` restores the scope in a `finally`. Tests:
3 new, 2 extended.

## 2026-10-16: Slice 9 part 3, the statutory notification pages (SAFE-002, SAFE-003)

- Web, read only: `/notifications/statutory` (still to do, then submitted or not required, each
  with its clock, status, subject, due time, location, recipient and warnings) and
  `/notifications/statutory/{id}` (the overdue alert's page: clock, status, warnings, every
  deadline, the record it was drafted on with its status, reasons, required content, sources and
  how it ended), for `safety.incident.manage`; the sidebar keeps Incidents current there, and the
  incidents list links to the pages for managers.
- #49 follow-ups on these pages: an "as of" line on the clocks (also on the incident page), a
  hidden person unnumbered on their own page and numbered consistently on the list, the source
  record named and linked with its status; the incident page links each notification to its page.
- i18n: 15 new `safety.notification(s).*` entries in English and Welsh (Welsh listed untranslated).
- Docs: safety.md section 5, HZ-013 rows, STATUS item 19, feature register SAFE-002.

**Tests**: `apps/web` `statutory-notifications.test.ts` (13) and one new axe test in
`IncidentNotifications.test.tsx`; `e2e/statutory-notifications.spec.ts` (3 journeys, hosted CI).

## 2026-10-16: Slice 9 part 3, review round 1 of #52 (SAFE-002, SAFE-003)

- The list reads each status on its own (HZ-013, clinical H1) and warns when unfinished
  notifications may be missing; communication needs beside who a notification is about (AIS);
  the person on a notification's page is read by id; a submitter without `manage` is told who
  can act (H-260); unreadable due times sort first; finished deadlines headed as history; page
  title, breadcrumb `aria-current` and described links on the incident page.
- Docs: HZ-013 rows moved into the Verification table; STATUS item 19.

**Tests**: `apps/web` `statutory-notifications.test.ts` 9 new; e2e names, axe on every page and
the needs of demo person 3 (hosted CI).

## 2026-10-16: Invitation routes, API part (PLAT-004, STATUS item 20)

- `POST /v1/invitations` (step-up), `GET /v1/invitations?tenantUserId=` and
  `POST /v1/invitations/{id}/revoke`, all narrowed to the members `platform.user.manage` reaches
  (#48 review), audited, refusals too.
- `POST /v1/invitations/lookup` and `/accept` with no session: throttled per client address and
  per token hash; the token goes to the definer functions only as a bound parameter; a sign-in is
  created only when none exists for the address and is deleted if the acceptance fails.
- `POST /operator/tenants/{id}/owner-invitation` sets `app.operator_id` and calls
  `app.invite_first_owner`; the link is emailed through the organisation's `comms.email` adapter,
  never queued.
- Worker: nightly `invitation-sweep` (lapsed invitations, then unlinked sign-ins deleted through
  the auth role).
- Docs: platform.md (As built), HZ-011 rows, H-356 and H-357, records of processing, STATUS item 20.

**Tests**: `apps/api` `invitations.test.ts` 20 new.

## 2026-10-16: Slice 11 part 3d, back-entry through the care routes (OPS-028)

Stacked on part 3c, then merged with main after #51 (operations.md section 14): the five care write
routes take a back-entry (outage, paper date and time as written, occurrence, outside reason,
reference) or a reason an entry is not from paper, and return the back-entry with its label.

- Rule 13 on every route; a reconciled outage refuses new paper records (H-204 words); one
  correction per paper record, a device's second kept for the refused-entry review (HZ-006); the
  outside-the-outage reason on a correction after the true end (H-208 words); the database's
  refusals in words; audit events carry the outage id.
- Contracts `BackEntryInput`, `EntryBackEntry`, `EntryNotFromPaper`; `openapi.json` and the client
  regenerated. The refused-copy daily limit is shared (`refusedCopyQuota`).
- Docs: operations.md section 14, HZ-017 and HZ-006 rows, H-216, STATUS.

**Tests**: `apps/api` `back-entry.test.ts`, 19 new (including the #51 round 2 closure test).

After #54 review round 1: `auditInTx` takes `scopeExtra`, merged into the request's scope, so care
writes keep the scope and places that authorised them; paper for a reconciled outage is kept for
the refused-entry review from every route (with a hand-over's admission; failures logged by opaque
ids; one shared copy limit); alerts and tasks from a back-entered observation say they come from
paper, with the paper time, and the outbox event carries it; the label falls back to the paper
time; the correction index's conflict maps to the 409; H-216 extended. Tests: 5 new, 3 extended.

## 2026-10-16: MFA counts only for the session that used it (#43 review M5)

- API: care records (and the operator console) need a session that signed in, or confirmed a
  code, with a passkey, an authenticator code or a backup code; having one enrolled is no longer
  enough. A Better Auth `after` hook records the factor per session in `auth.verification`
  (no migration). New refusal `mfa_verification_required` when a factor is enrolled but unused.
- Web: that refusal goes to `/sign-in?reason=mfa` (with the next path) and a message to use the
  passkey or the authenticator code; 3 new i18n entries (Welsh listed untranslated).
- Docs: ADR-0072, HZ-112, H-358, platform.md, STATUS item 20.

**Release note**: after this deploy, everyone signed in is asked to sign in again with their
passkey or authenticator code before opening care records. Sessions from before the deploy fail
closed (refused until they re-verify); nothing else is affected. The mobile app does not yet know
the new code (follow-up).

**Tests**: `apps/api/test/mfa-session-factor.test.ts` (6); harness and three test files mark their
password sessions as TOTP-verified; `apps/web` `problems.test.ts` (2) and `outcome.test.ts` (1).

## 2026-10-16: MFA session factor, security review round 1 of #57

- A password-only session can no longer enrol its own authenticator app or passkey, or remove
  the member's, once one is enrolled (a first enrolment still goes ahead); the web security page
  sends such a session to sign in with its factor. Five wrong codes per session, then sign in
  again. The factor record matches on its value too.
- Docs: ADR-0072, HZ-112 rows, STATUS item 20 follow-ups (step-up factor, mobile code).

**Tests**: `apps/api/test/mfa-session-factor.test.ts` 2 new (8 in all); `apps/web`
`problems.test.ts` 2 new.
