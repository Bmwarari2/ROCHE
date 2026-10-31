# The handover screen on the phone (STATUS item 15, screens gate 3(c), CARE-013)

Branch `feat/mobile-handover-screen`, from `feat/mobile-gate` (which carries PR #50).

## What changed

- The phone keeps each nation's shift pattern from every sync token (`handover_shifts`, ADR-0074)
  in the encrypted database's bookkeeping, so it is known offline.
- `care/handover-view.ts`: the outgoing handover for each home (the shift before the one running
  now, by the home's nation's pattern), said as "Not compiled yet", "Not final", final, or
  "Cannot tell" when the phone has no pattern for the home (gate item (e); H-303). Items worded
  from their summaries (gate item (a)) with the person, communication needs, late additions and
  items new since the reader's acknowledgement. What the phone holds and from when is said first,
  and an empty handover never reads as nothing to hand over (gate item (d)).
- The Handover tab, for members with `care.handover.manage`: one card per home, and "I have read
  this handover", saved over the items shown and waiting to upload, asking again for new items.
- Demo mode: a demo handover (a fall and an unfinished task), shown as the latest on the phone,
  since the demo has no shift pattern.
- Hazard log: HZ-018 and HZ-028 verification rows; care.md section 6.

## What is next

- Clinical and accessibility review of the screen.
- Notes on the handover and its items on the phone (the API takes them; the phone shows none yet).
- A Maestro flow for the handover once the live job runs (H-400).

## Tests

- `pnpm --filter @harbour/mobile test`: 56 files, 1085 tests, passing; typecheck and Biome clean.
