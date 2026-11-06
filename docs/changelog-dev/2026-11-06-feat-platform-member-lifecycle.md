# Member lifecycle (H-566)

Branch `feat/platform-member-lifecycle`, from `main` at `5dec5f37`. Builds H-566's recommended
answer so account deletion requests can be completed ([platform.md](../specs/platform.md), Member
lifecycle).

## What changed

- **Migration 0144**: `tenant_user` gains `status_changed_at`, `sign_in_erasure_requested_at` and
  `sign_in_erased_at`.
  - `app.change_member_status` suspends from active and ends from suspended, as the manager:
    `platform.user.manage` again, never your own membership, never the last active member who
    manages users; ending ends roles and grants.
  - A trigger keeps an ended membership ended and an erased row without a sign-in.
  - `app.sign_ins_due_for_erasure` and `app.memberships_of_sign_in`, owned by the membership reader.
- **API**: `POST /v1/members/{id}/suspend` and `/end` (step-up, coded reasons, audited, replays
  change nothing) and `GET /v1/members/{id}/lifecycle`.
  - Suspending ends the member's sessions unless they work for another organisation (H-354), stops
    Care mode with `not_a_member` and makes held entries due at once; shared devices stay in use.
  - Ending waits for held entries to be handed over (409 `entries_to_hand_over`).
- **Erasure**: once the member asked for deletion and no membership anywhere is invited or active,
  the Better Auth user and its sessions, accounts, passkeys and TOTP secret go, and the request
  closes as `sign_in_erased` (or `membership_ended_sign_in_kept` while another organisation keeps
  them). The nightly invitation sweep finishes any erasure that became due elsewhere. The member
  row, display name and job title stay (Regulation 17).
- **Web**: the member page in Settings, Team shows the membership, sign-in, deletion request and held
  entries, with suspend and end sheets. A seeded leaver (Lee Leaver, no sign-in) for the journey.
- **Docs**: platform.md, app-store-privacy.md, records of processing, data standards, retention,
  HZ-110 controls and tests (agreed with the lead: no new hazard), H-566 built, H-1390 to H-1395.

## Tests

- `packages/db/test/member-lifecycle.test.ts`, `apps/api/test/member-lifecycle.test.ts`,
  `apps/web/src/lib/team.test.ts`, `apps/web/e2e/member-lifecycle.spec.ts` (axe, light and dark).

## Review fixes

- Clinical: ending needs a coded device check when the member used any device (the phone cannot
  report once suspended); counts and hurried holds are the member's own, never a colleague's on a
  shared device; capped holds count, lost devices do not block; holds hurried before sessions end;
  the erased sign-in's id kept in the audit scope; HZ-110 reworded, shared-device note, deployer
  control extended, H-158 dependency.
- Security: erasure only after the membership that asked has ended and no membership anywhere is
  invited, active or suspended (tenants onboarding or active only); memberships marked before the
  sign-in is deleted so a stopped run finishes; audit only for what changed; one failure never
  stops the sweep; managers suspending each other serialised; the application role writes no
  status, sign-in link or lifecycle time; narrower grants on the cross-organisation reads; only a
  sign-in due is marked, and a new membership makes an erasure begun wait (N1).
- Accessibility: a late entries-waiting refusal shows the confirmation; destructive end button;
  plainer errors, hint, titles and a keyboard step in the journey.

## Left

- Reinstating a suspended membership (H-1392); a suspended phone's device report (H-1394); a
  lost-device hold closure (H-1395); reach checked in the database; the residuals in H-1393; an
  incident id with `device_lost_incident_raised`, a test for a capped hold blocking the end, and
  the end checks inside the status change's transaction (clinical re-review).
