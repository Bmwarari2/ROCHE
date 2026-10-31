# The round screen on the phone and its screens gate data (STATUS item 15, CARE-013)

Branch `feat/mobile-round-screen`, superseding PR #50 (whose head, `feat/mobile-round-gate-data`, is merged in). Mobile work resumed on 31/10/2026 after the owner's
pause from 16/10/2026.

## What changed

- Gate data (written on 13/10/2026, moved here from the frozen `CHANGELOG-DEV.md`):
  - (a) each handover item carries a worded summary (`handover_item.summary`: a catalogue key
    `handover.summary.*` and its parameters, codes plus a task's title and reason, never a person's
    name), which the phone words in English and Welsh, or by the item's kind when it has none;
  - (b) `task.from_earlier_plan`, the round view's "From an earlier plan" notice, kept on the task
    by the database with the same rule (`planRoundNotice`);
  - (e) the sync token carries each nation's shift pattern (`handover_shifts`), ADR-0074.
- Migration **0071** (was 0056, provisional): main reached 0070 during the pause, and drizzle skips
  a migration whose journal time is older than the last one applied, so the entry was regenerated
  after 0070 (`migration-journal.test.ts`). Its two definer functions are listed in
  `definer-acls.test.ts`, executable by their owner only. The ADR, numbered 0072 on the branch,
  is ADR-0074 (main took 0072 and 0073).
- The round screen (3(b)): open tasks overdue first, status as an icon and a word, what the phone
  holds and from when before any task (d), "From an earlier plan" (b), evidence waiting to upload
  offers nothing more (f), the needs-attention list above the tasks (g), refusals worded by role.
- Finished on 31/10/2026, with clinical and accessibility reviews of the screen:
  - the communication-needs flag (Accessible Information Standard) and "Urgent" as icon plus word
    on each card;
  - the person's record tags only the first entry saved for a task from the round, then says one
    is waiting (HZ-029, review M1);
  - the header counts the window's days from the last sync, not from now (HZ-028, review M2);
  - an entry for a task that Harbour refused is tied back to the task (HZ-006, review M3);
  - the reason field counts characters left instead of cutting text off; focus moves to it; its
    problem is announced; `removeClippedSubviews` removed; "Harbour could not" in place of "We";
  - tab titles through the catalogue; demo mode seeds three round tasks and can mark them;
  - the web handover test fixture carries the item summary.
- Hazard log: HZ-018, HZ-024, HZ-028 and HZ-029 rows. Human actions H-395 (one-tap "Done"
  without the compact header) and H-396 (stale-round warning age) for the CSO.

## What is next

- The handover screen (3(c)), which closes gate items (a) and (e) on the phone.
- Follow-ups from the clinical review (Low): open the form for the task's evidence type
  (`task.evidence_type` is not synced), show `escalation_level` on the chip.
- Follow-up from the accessibility review: return focus to "Not done" after "Cancel".
- The Maestro flow `hazard-HZ-028-round-on-the-phone.yaml` is written and parses; it has not run
  (see `feat/mobile-gate`).

## Tests

- `pnpm --filter @harbour/mobile test`: 52 files, 1045 tests, passing; typecheck clean; Biome
  clean.
- `packages/db` (real Postgres 16 locally): 34 files, 688 tests, passing.
- `pnpm --filter @harbour/web typecheck`: clean.

## PR #50 review round 1

Merged in from `feat/mobile-round-gate-data`: security M1 (`4c294aa4`: `care.handover.manage` needs
`safety.incident.read`, `care.note.read` and `people.person.read` at the same or a wider scope;
ADR-0071) and the code of clinical M1 to M3 (`6476f23a`: an alert's summary drops whether it was
acknowledged and carries why a care result was raised; a task's summary carries its plan action and
whether it was from an earlier plan). Finished on 31/10/2026:

- Docs for M1 to M3 and security M1: HZ-018 design and test rows, care.md section 6, data
  standards and records of processing (the plan action is the plan's own words).
- Clinical M4: the API logs a warning for the operator (organisation id, nations, rate keys) when a
  nation's shift figures are missing or out of order and are left out of the token; the claim's
  description says exactly what it holds and when a nation is left out (OpenAPI and client
  regenerated); an HZ-018 API test.
- Lows named in the round 1 handover note: the backfill no longer bumps versions or writes history
  (the version and history triggers are off while it runs), and the earlier-plan functions take the
  organisation from the row, so a write with no `app.tenant_id` keeps the notice rather than
  clearing it (the functions' signatures change; migration 0071 is unmerged, so it is changed in
  place). db tests for both.
- Not closed: the full list of round 1 Lows was not recorded in the repository (only the two above
  are named in the handover note), so any others remain for the next review.

## PR #123 security review

- M1: `care.handover.manage` also needs `care.plan.read`, since a task's summary carries its plan
  action in the plan's own words (`PERMISSION_PREREQUISITES`, ADR-0071; domain and API tests).
- M2: a route's `task` tags an entry only when the device holds that task for that person, open and
  not already marked (`useRoundTaskFor`, `ROUND_TASK_FOR_PERSON_SQL`); `taskTitle` is no longer
  passed, and the record shows the synced title; `+native-intent` strips `task` and `taskTitle`
  from links from outside the app.
- L1: data standards and records of processing list what a handover item's summary carries (a
  task's title, plan action and reason not done); the code comments say what is true; "migration
  0056" corrected to 0071.
- L2: the summary check allows only the eleven keys, nothing beside the key and parameters, scalar
  parameters (a strict JSON path) and at most 4 KiB (0071 regenerated in place).
- L3: alert reasons look observations up by uuid, so the primary key is used.
- Optional: the refresh computes the flag once per series; the task trigger skips its lookup when
  the session's organisation is not the row's.

## PR #123 clinical review

- H1 (HZ-029, HZ-018, HZ-003): every task, evidence ones included, offers "Not done" with a
  reason; the record's banner no longer presents a note as completing the task; HZ-029 and care.md
  record that the API takes an entry of any kind as evidence until `task.evidence_type` syncs
  (H-423).
- M1: a task is answered by one entry from this device, remembered after the entry uploads and its
  synced copy drops `task_id` (`answered-tasks.ts`); HZ-029's row corrected.
- M2: a one-tap move is refused about a person whose record is not on the phone, whoever the task
  is given to.
- M3 (HZ-001): the person's name in each button's spoken label (the Maestro selector follows);
  communication needs by name; H-395 states the full gap against the web round, with the default in
  force; an HZ-001 control row and render test.
- M4 (HZ-028, HZ-009): the phone keeps the token's `offline_days` and the header states the window
  from them in UK time; tests at 23:30 UTC in BST and on both clock-change Sundays.
- M5 (HZ-016): both texture alerts say "food or a drink" and that it may not be safe; food rows in
  the domain table; the API's reason text.
- M6: a NEWS2 alert's summary carries the score and band found, in the past tense with the
  published band names; noted under H-127 and H-129.
- Lows: L1, L8, L9, L10, L11, L12 in code; L3 (ADR-0074 in H-303), L4 (HZ-018's row and the Welsh
  placeholders), L5 (care.md and HZ-018 no longer claim the phone says it cannot tell before the
  handover screen merges, and list the tests that PR must carry) and L13 (CARE-013's phone paths) in
  docs. Logged for the CSO: L2 (H-396 reframed around the 15-minute banner), L6 (H-424), L7 (H-425),
  splitting the screens gate (H-426), free text on phones (H-427).

## PR #123 clinical re-check

- M1: the answered state is kept in the encrypted bookkeeping (`sync_meta`), by member and task, in
  the entry's own transaction; it survives a restart, the hold clears it, a refusal of that entry
  makes the task answerable again, the round reads it ("Sent, not marked done", nothing offered),
  and the record's banner follows (waiting, sent, or normal after a refusal). Tests for each case.
- M2: a token's `offline_days` are recorded only once a sync that finished after the token was
  fetched completes; a failed write removes the old window, so the round says it cannot tell.
- M3: only the entry a task asks for completes it, in the domain (`isEvidenceFor`), the API (every
  entry route says what it is) and on the phone: never a note, and for a chart's task only that
  chart; anything else is kept and reviewed. H-423 stays open for the CSO.
- Lows: the 23:30 UTC test computes its days as the API does; the API's unsafe-texture reason
  matches the handover's words; NEWS2 low-medium says "because a single parameter scored 3"; the
  trigger-code doc comment is back on its function.

## PR #123 check at c6a85f2b

- M1 edge cases: removing a refused entry forgets the answer it gave, in the same transaction
  (`FORGET_ANSWER_FOR_ENTRY_SQL`), so the task can be recorded again; putting held entries back
  rebuilds their owner's answers, which the hold had cleared. Tests for both.
- Low: when a waiting or sent chip takes the status chip's place, "Overdue" or "Overdue: escalated"
  stays in sight as its own flag.

