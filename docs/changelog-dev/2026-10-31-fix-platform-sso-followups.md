# SSO follow-ups from the round 3 security check

Branch `fix/platform-sso-followups`.

## What changed

- **Low: a race in reading which organisation a session is from.** The session middleware
  (`apps/api/src/http/context.ts`) and the auth gate (`apps/api/src/auth/sso-gate.ts`) read the
  session row a second time to find its SSO organisation. A request racing a sign-out or the end
  of an SSO session found no row there and was taken for a password session, skipping the flag
  check, the organisation binding and the operator refusal. Both now read `ssoTenantId` from the
  session Better Auth has just resolved (`ssoTenantOf`); the second read is gone. Test:
  `apps/api/test/sso.test.ts` (`#33 re-check 3 L`), where the second read finds nothing and the
  session is still refused while the flag is off, on the API and on Better Auth's routes.
- **Info.** platform.md rule 24 now says that a sync token issued while the flag was on stays
  valid for up to 15 minutes.
- **Info.** The HZ-112 follow-up now says the password alone can use up the member's codes,
  through the sign-in's own code step.

## Found, not fixed here

- None.
