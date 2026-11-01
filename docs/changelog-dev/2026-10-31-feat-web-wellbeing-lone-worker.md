# Lone-working web screens (Phase 2 slice 61, part 1)

Branch `feat/web-wellbeing-lone-worker`, cut from `feat/sched-lone-worker` (slice 46). No
migration. Hazard HZ-125; human actions H-1140 to H-1146. The wellbeing screens, the other half of
slice 61, wait for the wellbeing API (`feat/sched-wellbeing`, not yet pushed); H-1147 to H-1149 are
kept for them.

## What changed

- `apps/web`: "Lone working" in the navigation for holders of the check-in, monitor or manage
  permission ([scheduling.md](../specs/scheduling.md) section 14.8a).
  - `/lone-working`: the worker's own session. Start (where, kind of work, how long, how often),
    check in, ask for help (one press, never disabled, "call 999" if it may not have been sent) and
    finish (asks first). Duress is never offered or named on the web (H-1140).
  - `/lone-working/board`: open alarms first, duress first, each naming the worker with what to do
    and the acknowledge form; then every open session, those with an alarm first. It reads again
    every 30 seconds, never while an acknowledgement is being written, with a pause, a stale
    warning, announcements of new alarms and the count in the tab's title.
  - `/lone-working/route`: the on-call route, with the API's problems in words.
- API: `LoneWorkerBoardItem.workerName`; the board leaves out the viewer's own session, so a duress
  press never shows through on it. OpenAPI and the generated client regenerated.
- Strings `scheduling.loneWorker.*` in English; Welsh marked untranslated (H-1143).

## Reviews

The accessibility and clinical-safety reviewers ran on the screens; their findings were fixed
(focus and confirmations after start, finish and acknowledgement; the editing guard, pause, stale
warning and announcements on refresh; the channel error tied to its checkboxes; row headers and a
focusable scrolling table; the retry window; help never disabled; the web tier's clock for events;
the acknowledgement retried after a re-alert; the monitor's own session off the board). Decisions
left for the CSO and DPO are H-1140 to H-1146.

## Tests

- `apps/web/src/lib/lone-worker.test.ts` (table-driven: order with duress first, status words,
  forms' refusals, announcements, the retry window).
- `apps/web/e2e/lone-working.spec.ts` (route, start, check in, help, the board, acknowledging and
  finishing, with axe at each state; the carer refused the board and the route).
- `apps/api/test/lone-worker.test.ts`: the board names each worker and leaves out the viewer's own
  session.
