# 2026-10-17: Slice 12 part 2b, the family's updates page (COMMS-001)

- Web: `/updates` for a family member's portal session (their home, and "Updates" in the side bar):
  the statement that these are not the full care record, the time checked and the last update,
  each update and a "Taken down" notice for one they saw; a closed feed reads exactly as no
  decision; an MFA notice with the way to set it up.
- Local end-to-end: `seed-users.ts` adds Ada Example's invented next of kin as a portal account with
  the end-to-end passkey (`HARBOUR_DEMO_E2E_PASSKEY=1` only).
- Docs: comms.md section 11, HZ-061 (the web row now passing), the register, STATUS.

**Tests**: `apps/web/e2e/family-feed.spec.ts` (2, axe on every state); `apps/web/src/lib/family-feed.test.ts`
(the portal-only home).

Review round 1 of #88: a family member sees no staff navigation (the people link needs
`people.person.read`; no location switcher); an account with no access at all (such as a family member whose link was
revoked) is sent to `/updates` and told how to get it; the MFA notice in plainer words; axe on the MFA notice and the
not-linked page; the e2e passkey helpers renamed `addDemoPasskey` and `signInWithDemoPasskey`; the
seed stops with an error when no contact matches. Numbered feeds stay a logged follow-up.
