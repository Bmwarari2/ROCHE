# Harbour: handover to the next session (12/10/2026, late evening)

Read with `CLAUDE.md`, `docs/01-CONSTRAINTS.md`, `docs/plans/STATUS.md` and the lane briefs in this
folder (`lane-rules.md`, `lane-a.md` to `lane-d.md`). The owner's standing instructions and the
faster process from the previous handover still apply: small PRs, hosted CI is the gate, up to three
build lanes in worktrees, at most two review rounds per PR (round 1 full, round 2 fix commits only),
a High always blocks, a Medium blocks only if introduced with a realistic harm path and no
mitigation, everything else goes to STATUS follow-ups. Every PR gets a reviewer-agent pass before
merge (security for db/api/sync/infra/mobile storage, clinical for care/medicines/safety/sync/
notifications, accessibility for UI), and a one-comment review summary on the PR before merging
with a merge commit and `expectedHeadSha`.

## Merged this session

| PR | What |
| --- | --- |
| #27 | Data scope per permission (ADR-0071), after a round 5 check; the unrouted alarm now sums over an hour |
| #29 | Commitlint ignores Dependabot's own commits |
| #30 | Task series and care review sweeps through `eachTenant`; round view tests off the clock; esbuild 0.28 |
| #31 | CodeQL uploads to code scanning (H-17 done: owner turned default setup off, secret scanning and push protection on) |

`main` is at `34bc001`, green on hosted CI and CodeQL (no findings). Dependabot's #28 closed itself.

## Open PRs

1. **#32 Lane A, downtime pack and outage schema** (`feat/operations-downtime-schema`, head
   `9102dc8`, migrations 0050 and 0051). Rounds 1 and 2 done (security and clinical); round 2's new
   clinical medium was fixed in `9102dc8` and checked by the coordinator (content keys match the
   domain's `DowntimePack`; fails closed). **Blocker: merge conflict with main** (shared docs:
   CHANGELOG-DEV, STATUS), so hosted CI has not run on `ee03bb1` or `9102dc8`. Next: merge
   `origin/main` into the branch keeping both sides, push, wait for CI green, post the summary
   comment, merge. Then tell Lane C (below).
2. **#33 Lane C, task and handover sync streams** (`feat/mobile-tasks-handover-sync`, head
   `123f2b2`). Rounds 1 and 2 done, all mediums closed or logged as a screens gate. **Waiting on
   #32**: after #32 merges, merge main in and add migration **0052** (custom SQL: `ALTER
   PUBLICATION powersync ADD TABLE` for `task`, `handover`, `handover_item`, `handover_note`,
   `handover_acknowledgement`; the `sync_replication_read` policy and `GRANT SELECT` to
   `harbour_sync` on each, as 0012 and 0017 do) with a db test that every table a stream reads is in
   the publication. Same push: screens gate item (e) in STATUS item 13 and care.md section 6 (the
   phone must be able to say the outgoing handover is not compiled yet or not final; needs the
   shift pattern on the device; add to H-303); H-304 notes that `handover_staff_acknowledgement`
   relies on PowerSync treating `FROM ... AS alias` as the device table name (simulator proof); a
   STATUS low for a test of a carer assigned to two people at different homes. A short round 2
   check of the migration, CI green, merge.
3. **#34 Lane B, consent, capacity and DoLS tab part 1** (`feat/web-mca-tab`, head `4982d19`).
   Round 1 found 6 clinical and 3 accessibility mediums (list below); Lane B reports all 12 items
   fixed in `daf4fa7..4982d19` (web unit 388, i18n 48, Playwright capacity and care-record 15
   passing locally). **CI red on `4982d19`**: the new `e2e/capacity.spec.ts:282` ("the tab reflows
   at 320 px and says when nothing is recorded") finds the empty tab scrolling sideways by 11 px
   at 320 px (WCAG 1.4.10; passed locally only on the shared database). Fix the overflowing element
   first (trace in the job's test-results artifact), then round 2 on the fix commits
   (accessibility and clinical), CI green, summary comment, merge.

## Pushed branches not yet PRs (open them in this order as their bases merge)

- Lane A part 2 `feat/operations-back-entry-columns` (head `fd53864`, migration **0053**, about 505
  hand-written lines): back-entry columns on the five care tables, cancel refused once cited,
  reconciler check, correction refused if it leaves a citing entry outside the window. Needs #32
  and #33 merged first (journal skips idx 52 until 0052 lands), then a full round 1.
- Lane A part 3 (downtime API, nightly job, PDF): in progress when the session stopped; see
  Lane A's last report for its branch and SHA if it pushed. Requirements in operations.md section
  12 (rebuild on any move, kiosk fetch context, pack PDFs out of `document` or behind a restrictive
  policy, unconfirmed MAR/PEEP places printed as not set with a task for the Registered Manager).
- Lane C PR 2(a) `feat/mobile-offline-round-writes` (head `7d53fa8`, 703 lines, on #33) and PR
  2(b) `feat/mobile-offline-round-upload` (head `b4a06e8`, 744 lines, on (a)). Open after #33
  merges; full round 1 each. Delete the stale `feat/mobile-offline-round-actions`.
- Lane B part 2 `feat/web-mca-records` (head `6c23c78`, about 900 lines over #34, on its fixes):
  the capacity assessment, best-interests and consent record views. Not done: the round 1 standards
  in its own views ("Refused" chip tone, the consent history link's name and 44 px size, `<time>`
  elements), its Playwright journey re-run after the merge, and the forms. Open after #34 merges.
- Lane D `feat/platform-flags-and-sessions`: not started (no commits). Plan from its reading:
  flags through one provider that drops soft-deleted overrides (today `/v1/me` counts them); admin
  revoke on `platform.user.manage` plus step-up (a new permission would need a 0031-style role data
  migration); idle timeouts as rate keys `session.idle_timeout_minutes[.<role>]`, browser cookie
  sessions only; check whether web polling keeps sessions alive.

## #34 round 1 fix list (for Lane B, or whoever finishes it)

Clinical (HZ-020, HZ-026): (1) a legal-change review not yet started (null) on an authorisation the
domain counts as awaiting review shows a warning chip with a next step; (2) an expired authorisation
named in a later one's `precededByAuthorisationId` shows a neutral "Renewed", not red "Expired";
(3) an end at 00:00 UK time shows the last day in force ("In force until the end of 20/10/2026"),
"Last day in force" only on that day, tests for midnight, 10:00 and across 25/10/2026; (4) web route
`/people/{id}/dols` redirects to `/people/{id}/capacity` (the expiry alert links there); (5) tests
for "No valid consent" with its reason and the overdue capacity review chip; (6) the capacity
finding shows its date and the review date or "No review date set".
Accessibility: (7) map API text (cqc.reason, Wales "Phase 7" text, decision.message) to catalogue
keys, en-GB and Welsh; (8) the axe journey renders every warning state, a keyboard step and a 320 px
check; (9) "No consent recorded" with its message. Cheap lows: unknown values warn (ICU `other`
fallbacks), "Refused" not on the `info` chip, no "Granted Not recorded", 44 px history link, unique
headings and link names, `<time datetime>`, `break-words`. Log: CSO human actions in H-250+ (end
date display and typed-date mapping, default typed date is the last day in force; renewed vs
expired; refusal as warning; missing review "not started"), STATUS follow-ups (CQC draft overdue
cue, reminder sent or acted on, "Last day in force" timing, empty DoLS next step).

## Id ranges in use

Human actions: H-200 to H-202 used (Lane A), H-300 to H-304 used (Lane C); Lane B from H-250, Lane D
from H-350. Hazards: none new yet (ranges HZ-080 to 119 by lane). Migrations: 0050 and 0051 (#32),
0052 (#33, to add), 0053 (Lane A part 2), 0054 next.

## After Phase 1

Phase 1 gate: Maestro offline journey on iOS and Android, inspector pack renders, WCAG scans
clean, every hazard has a test, safety case v0.1. Then Phase 2 with the same lanes. When the build
is complete, run the Cloudflare security-audit skill (MIT, read and checked) read-only against the
repository and fix what it finds.

## Build tracker

https://claude.ai/artifact/7c8zgg7CZYHZSh3WY32qtV (ArtifactData; read a document, then write with
`if_version`). Step p1-b16 is done; p1-b11 notes #32; `meta/status` was last set at 22:55.
