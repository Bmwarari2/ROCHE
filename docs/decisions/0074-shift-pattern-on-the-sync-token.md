---
status: "accepted"
date: 2026-10-13
decision-makers: Claude Code (lead engineer, Lane C), for the screens gate in STATUS item 15; Brian may supersede
consulted: master prompt sections 3 and 6 (offline-first at the point of care); care.md rule 8 and section 6 (screens gate item (e)); ADR-0071; #33 review round 2 (H-303)
informed: everyone working in this repository, the CSO
---

# The phone learns the shift pattern from its sync token

## Context and problem statement

The handover screen on the phone must be able to say "the outgoing handover is not compiled yet"
or "not final" (screens gate item (e), H-303). A `handover` row reaches the phone only once
someone, or the worker after the shift ends, has compiled it. `locked_at` empty means "not final".
Nothing on the phone says which handover it should hold, so it cannot tell a handover that
nobody has compiled from one that does not exist. The shift pattern is in the rate table: two
start times per nation (`handover.day_shift_start_minute`, `handover.night_shift_start_minute`),
until rotas define shifts per location (Phase 2, H-153). The pattern has to reach the phone
offline, which means through sync. Should it come through a new sync stream, or on the token?

## Decision drivers

- Offline first: the phone must work out the expected shift with no network, across a shift
  change.
- The streams cannot read the clock or work out which rate row is in force on a given day (rows
  are dated, per nation, with tenant overrides). The API already resolves that (`rateNumber`).
- Least privilege: only someone who receives handovers needs the pattern.
- Keep the sync design small: no new published table, no new policy for the sync role.

## Considered options

- A claim on the sync token: each nation's day and night start times, resolved by the API.
- A sync stream of the rate table's handover rows, worked out on the phone.
- The expected shift end on the token for each location.

## Decision outcome

Chosen option: "a claim on the sync token".

- `POST /v1/sync/token` adds `handover_shifts`, a map of nation to `{ day, night }`. Each value
  is in minutes after midnight, UK time.
- The map covers each nation the organisation has homes in. It is sent only where the handover
  family reaches (`handover_location_ids` or `handover_assigned`).
- A nation whose figures are missing, or are out of order, is left out. The phone then says it
  cannot tell which handover to expect.
- No stream reads the claim. The phone reads it, as it reads the write-scope claims (ADR-0071
  review round 2), keeps the last one, and works out the expected shift with the domain's own
  `twoShiftPattern`, `shiftAt` and `previousShift`.
- A token lives 15 minutes and the pattern changes only with the rate table, so a phone that has
  synced recently holds the pattern in force.

### Consequences

- Good, because the phone works out the outgoing shift offline, across shift changes and clock
  changes, with the same functions the API uses to compile handovers.
- Good, because the rate table's dated, per-nation rows stay resolved in one place, the API.
  Nothing new is published or granted to the sync role.
- Bad, because a change to the shift times reaches a phone only with its next token. A phone
  offline across that change words the expected handover from the old times. The handover
  screen says what the phone holds and from when (gate item (d)), so this shows as a mismatch and
  is never silent.
- Bad, because the token grows by a few dozen bytes for each nation (at most four).

### Confirmation

- `apps/api/test/api.test.ts`: the manager's token carries the demo home's pattern from the rate
  table.
- The handover screen pull request (3(c)) tests the phone's reading of the claim, and the words
  "not compiled yet" and "not final".
- `packages/sync/src/streams/index.ts` documents the claim on `SyncTokenClaims`.

## Pros and cons of the options

### A sync stream of the rate table's handover rows

- Good, because a rate change would reach the phone with the next sync, not the next token.
- Bad, because the phone would have to choose the row in force (dated, per nation, with tenant
  overrides), repeating the API's rule in a second place.
- Bad, because it publishes a new table to the sync role.

### The expected shift end on the token for each location

- Good, because it is the simplest thing for the phone to read.
- Bad, because it is wrong as soon as the shift changes while the phone is offline: a night shift
  that starts offline would still expect the day's handover.
