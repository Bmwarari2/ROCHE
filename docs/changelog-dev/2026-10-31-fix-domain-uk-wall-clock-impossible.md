# A date that does not exist is refused, not retried for ever

Branch `fix/domain-uk-wall-clock-impossible`.

## What changed

- `packages/domain/src/shared/time.ts`: `fromUkWallClock` moved a time in the spring-forward gap an
  hour later by calling itself, with no limit. Given a date or time that does not exist on any
  calendar (31/11, 29/02 in a common year, 24:00, minute 60) it called itself until the stack ran
  out. It now makes the one-hour step once and otherwise throws `RangeError("Not a time on the UK
  clock")`. No caller relied on the old behaviour (each such call already failed). Found by the
  Phase 2 slice 2 builder through a test helper.
- `packages/domain/src/shared/time.test.ts`: table-driven refusals under HZ-009.

## Human actions logged

- None.

## Tests

- Domain: 4338 passed; the new cases fail on the old code (stack overflow, not the refusal).
