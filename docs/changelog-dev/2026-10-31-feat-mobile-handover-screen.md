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

- `pnpm --filter @harbour/mobile test`: 56 files, 1090 tests, passing (after the review round); typecheck and Biome clean.

## Review rounds

- Clinical review (one High). H1: in the overlap before a shift changes, the screen showed the
  shift before last as "Final" and hid the running shift's handover its staff had just compiled;
  the card now shows that one first as "This shift, not final", then the outgoing one (lead time:
  H-420). M1: under "Cannot tell" the newest handover shows its own shift and state (whether the
  phone may acknowledge it: H-421). M2: only homes whose handover the phone receives are listed,
  from the token's handover reach (kept with the pattern, cleared when it ends, L1). L2: the spring
  clock change is tested. Wording (L5). Left open: seeding a pattern in demo mode (L4; the shift
  times are rate-table figures), showing a handover compiled under older shift times (L3), and
  H-422 (per-location shifts, a stale-sync warning).
- Accessibility review (no High): the communication flag sits inside the person's group, and a
  person not on the phone says their communication needs are not here either; plainer wording
  for "not compiled yet" and "final". Left open: a Maestro flow for the handover (it needs a
  compiled handover in the live CI job, after H-400), announcing a status change when the shift
  moves on, the "waiting to upload" chip read twice after a save, and an icon on the refusal text.

