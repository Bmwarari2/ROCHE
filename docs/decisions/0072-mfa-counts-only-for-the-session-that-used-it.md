---
status: "accepted"
date: 2026-10-16
decision-makers: Claude Code (lead engineer), on #43 review finding M5; Brian may supersede
consulted: master prompt section 5.3 (MFA for every role reading care records); ADR-0009 (Better Auth); ADR-0030 (session cookies); HZ-112
informed: everyone working in this repository, the data protection lead, the CSO
---

# MFA counts only for the session that used it

## Context and problem statement

The API treated MFA as satisfied for care records (`careRecord: true` permissions) whenever the
member had an authenticator app (TOTP) or a passkey enrolled. Better Auth asks for the TOTP code at
a password sign-in when TOTP is on, but a member with only a passkey could sign in with their
password alone and open care records: the passkey proved nothing about that session. The operator
console had the same check. How should the API know that a session used a second factor, without
a schema change to Better Auth's `auth.session` table (only Lane A adds migrations)?

## Decision drivers

- Section 5.3: MFA for every role reading care records means the session, not the account.
- Fail closed: a session with no record of a factor is refused, including every session issued
  before this change.
- No migration in this change; keep the record inside the `auth` schema that only `harbour_auth`
  reaches.
- Do not send someone who already has a second factor to an enrolment page (a dead end).

## Considered options

1. A `second_factor` column on `auth.session` through Better Auth `session.additionalFields`.
2. **A record per session in Better Auth's own `auth.verification` table, written by an `after`
   hook on the routes that prove a factor.**
3. Infer it: TOTP holders cannot finish a password sign-in without the code, so count TOTP and
   refuse passkey-only members unless they hold TOTP too.

## Decision outcome

Chosen option 2, because it needs no migration and fails closed.

- `apps/api/src/auth/better-auth.ts`: an `after` hook on `/passkey/verify-authentication`,
  `/two-factor/verify-totp` and `/two-factor/verify-backup-code`, only when Better Auth accepted
  the request, writes `session-factor:<session id>` with the factor (`passkey`, `totp` or
  `backup_code`) and the session's expiry. It marks the new session a sign-in created, or the
  current session when a code is confirmed on it (a step-up in place). A backup code counts: it is
  the recovery code issued with the authenticator app.
- `apps/api/src/auth/session-factor.ts` `sessionMfa`: `enrol` when nothing is enrolled
  (`mfa_enrolment_required`, as before), `verify` when a factor is enrolled but this session has
  no record (`mfa_verification_required`, new), `satisfied` otherwise. One query; the record's
  expiry follows the session's as the API moves it on.
- The tenant middleware and the operator console both use it. The web sends
  `mfa_verification_required` to `/sign-in?reason=mfa` with a message to use the passkey or the
  authenticator code; `mfa_enrolment_required` still goes to the security settings.
- Once a member has a factor, the routes that add, show or remove one (`/two-factor/enable`,
  `/two-factor/disable`, `/two-factor/get-totp-uri`, `/two-factor/generate-backup-codes`,
  `/passkey/generate-register-options`, `/passkey/verify-registration`,
  `/passkey/delete-passkey`) need a session that used one (`MFA_VERIFICATION_REQUIRED`
  otherwise); a first enrolment goes ahead on a password session. Without this, a password alone
  could enrol the attacker's own factor and pass the check (#57 security review round 1). A
  session gets five wrong codes on `/two-factor/verify-totp` and `/verify-backup-code`, since
  Better Auth limits them only at sign-in.
- A session signed in on a trusted device (Better Auth's `trustDevice`, which Harbour does not
  offer) or with a password alone does not count.

### Consequences

- Good: a password alone never opens a care record; the same rule covers the operator console.
- Good: no migration; the record lives and is swept with Better Auth's own verification rows.
- Bad: every session from before the deploy is refused care records until the person signs in
  again with a passkey or code (or confirms a code on the session). The release note says so;
  H-358 plans the deploy outside a shift handover.
- Bad: the mobile app does not yet know `mfa_verification_required` (mobile is paused); until it
  does, a refused sync token is read as withdrawn access rather than an ended session (STATUS
  follow-up, HZ-112).
- Neutral: a record Better Auth sweeps before the API moves its expiry on fails closed.
- Option 1 remains the cleaner store; Lane A may move the record to a column later without
  changing the rule.

### Confirmation

`apps/api/test/mfa-session-factor.test.ts` (HZ-112): a passkey holder's password-only session is
refused; a passkey session is allowed; removing the passkey refuses again; a wrong code records
nothing; a code confirmed when enrolling, on an existing session, or at a new sign-in is allowed;
a session with no record is refused. `apps/web/src/lib/problems.test.ts` and `outcome.test.ts`
cover the web's handling.

## Amendment (2026-10-16): step-up needs a factor used within the window

Section 5.3 asks for step-up on controlled drugs, residents' money, export and break-glass. Until
now a step-up permission passed with any sign-in inside `STEP_UP_WINDOW_SECONDS`, so a fresh
password sign-in counted, and for a member who needs no MFA a password alone stepped up.

**Decision.** Step-up counts from the latest second factor this session used (a passkey, a verified
authenticator code or a backup code), never from the sign-in time:

- Each use of a factor is its own row in `auth.verification` (`session-factor:<session id>`), and
  its `created_at` is when it was used, so no column or migration is needed. `sessionFactorState`
  returns the MFA state and whether the latest use is fresh, judged in SQL on the database's clock
  (`now() - max(created_at) <= STEP_UP_WINDOW_SECONDS`, inclusive, as "within 10 minutes" reads);
  the tenant middleware carries it as `TenantAccess.stepUpFresh` and the operator middleware as
  `OperatorIdentity.stepUpFresh`. Domain checks take `stepUpAt` (the request time when fresh, else
  null), never a sign-in time.
- Every step-up check reads it: `refusalOf` (each `requirePermission` of a step-up permission),
  `stepUpFresh` (workflow moves, `requireStepUp`, task links) and the operator's owner invitation.
- A member who holds a step-up permission with no factor enrolled is refused with
  `mfa_enrolment_required`, whether or not their roles need MFA for care records.
- Confirming a code on an existing session (`/two-factor/verify-totp`, `/verify-backup-code`, under
  the five-attempt limit) or signing in again with a passkey adds a row and so refreshes the time.
- The code that completes a first enrolment (no factor before the request) records no factor: it
  proves only the password. The person signs in again with the new factor before step-up or care
  records count it (#63 security review, M1).
- The web flows (break-glass, statutory notification submit and "not required", the downtime pack)
  keep sending the person to `/sign-in?reason=step-up` and back; the words now say "confirm with
  your passkey or authenticator code".

**Consequences.** Good: a password alone never steps up a member who has a factor, and enrolling a
first factor does not step the enrolling session up. Residual: for an account with no factor yet,
someone holding the password can enrol their own authenticator and then sign in with it; that is
the limit of any first enrolment, closed by enrolling every step-up holder before go-live (H-359)
and by invitation-time enrolment. Bad: a person who signed in with a code
more than 10 minutes ago confirms it again before a step-up action (as before with a sign-in);
members holding a step-up permission without a factor must enrol one first (H-359). Neutral: Better
Auth's own `freshAge` is unchanged and governs only its own endpoints.

**Confirmation.** `apps/api/test/step-up-factor.test.ts` (HZ-112): every step-up permission in the
catalogue against a password-only session, a factor inside and outside the window and no factor;
each step-up route family over HTTP (with About me links, residents' money at exit and task links);
no factor enrolled; an in-session authenticator or backup code refreshes the step-up and five wrong
codes do not; no API or domain source gives a step-up check a sign-in time.
`mfa-session-factor.test.ts`: the code completing a first enrolment records no factor.
