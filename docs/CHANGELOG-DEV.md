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
