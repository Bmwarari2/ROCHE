# The phone reads mfa_verification_required as a session code (HZ-112, HZ-006)

Branch `fix/mobile-mfa-verification-session`, from main.

## What changed

- `apps/mobile/src/sync/session-signals.ts`: `mfa_verification_required` (a factor is enrolled
  but this session did not use one, ADR-0072) joins the session codes. On the sync token the phone
  signs in again, keeping unsent entries under the hold rules, rather than reading the 403 as
  access withdrawn; on an upload it ends the session instead of parking the care entry in "needs
  attention" as refused, where the carer could have deleted it.
- Hazard log HZ-112: the mobile control and its verification row, planned until now.

## What is next

- Nothing on the phone; the residual risk is the CSO's to accept (H-358).

## Tests

- `pnpm --filter @harbour/mobile test` (`src/sync`: 339 tests) passing; typecheck and Biome clean.
