# Harbour: resume notes (paused 16/10/2026 for usage limits)

The owner asked to pause at 03:26 UK time on 16/10 and resume at 05:30 UK time the same morning
(a scheduled task fires then; the file name is historical). Read `NEXT-SESSION-PROMPT.md` and
`lane-rules.md` in this folder first; this file says where the session of 16/10 stopped. Commit
attribution for that session used `Claude-Session: https://claude.ai/code/session_015cg4ByhMnh47XnHt2PKp2x`.

The owner asked for a quiet chat: post only what needs their attention (decisions, blockers,
Phase 1 done), and keep the build tracker artifact updated at every PR open and merge.

## Merged on 16/10

#51 outages API, #52 statutory notification pages, #53 invitation API, #54 back-entry on the care
routes, #55 recording an incident, #56 evidence pack schema (migration 0057), #57 MFA counted only
when the session used a factor. Main is at d5f1906 or later.

The owner approved one CI change (in #54): `apps/api/openapi-breaking-ignore.txt` holds one exact
oasdiff false positive, passed with `--err-ignore` in CI and `scripts/ci-local.sh`. Never add to it
without the owner's approval.

## Open PRs and their state

| PR | Branch | State | Next step |
| --- | --- | --- | --- |
| #58 incident review, close, submit | feat/web-incident-review-submit | Two review rounds passed; coordinator fix 2c4e412 | Merge main in (conflicts in apps/web/src/lib/outcome.ts and cy.status.json; keep both behaviours), retarget base to main, CI, merge |
| #59 invitation accept page | feat/web-invitation-accept-page | Two rounds plus final coordinator check passed; CI was green at f58fedb | Merge main in (conflicts in CHANGELOG, en-GB.json, cy.json), CI, merge |
| #60 evidence pack internal routes and bundle sweep | feat/quality-evidence-pack-api (base main) | Clinical round 1 done (below); security round 1 was stopped by the pause, re-run it | Security review; fix round 1 |
| #61 statement of purpose routes and overdue job | feat/quality-statement-of-purpose-api (base #60) | Clinical round 1 done (below) | With #60 |
| #50 mobile round gate data | feat/mobile-round-gate-data | Draft, mobile paused by the owner | Leave |

Work in progress, no PR yet (check the branches for the latest pushed work):
- `feat/web-downtime` (Lane B): downtime pack, outages and back-entry web screens, PR A.
- `fix/platform-step-up-factor` (Lane D): step-up needs a second factor used within the window.
  No code yet (branch equals main). Plan: step-up time today comes from the session's sign-in
  time in `refusalOf` (`apps/api/src/http/context.ts`), `workflow-shared.stepUpFresh`,
  `care-shared` and `operator-invitations`; the 12 step-up permissions are in
  `packages/domain/src/platform/permissions.ts`. Take the time from the session's latest factor
  record in `auth.verification` as `stepUpAt` on `TenantAccess`; no factor enrolled gives
  `mfa_enrolment_required`; tests that age `auth.session.created_at` need a harness helper that
  ages the factor record too.

## Clinical review round 1 of #60 and #61 (to send to the lane)

Blocking in #60:
1. Release does not re-check corrections: `apps/api/src/routes/evidence-packs.ts:584-600`. Re-run
   `corrected()` and compare `recordVersion` for every item at release; refuse with 409 if any
   changed (HZ-050).
2. Corrections and paper back-entries are not labelled in the bundle
   (`apps/api/src/services/evidence-pack.ts:235-305`): add "Correction of an earlier entry" with the
   reason, "Back-entered from paper" with the paper time and reference, the recording time and the
   clock-drift flag; an HZ-050 test each.
Lows: readings need labels and units per chart, and IDDSI codes allowed (`evidence-pack.ts:277-281`);
times need a GMT/BST marker and a DST test (`packages/domain/src/shared/time.ts:42`); #61's 28-day
test hides DST (`Math.round`); #61's overdue alert wording names neither version nor due date; #61
adds no hazard row or hazard-named test. For the CSO: whether the statement of purpose overdue
alert is in DCB0129 scope; H-219 wording, a "due soon" reminder and recipients; H-218 how
corrections, back-entries and units appear to an inspector; whether a released pack states it
reflects the record at release time.

## Housekeeping

- `docs/plans/human-actions.md` uses H-216 twice (#54 and #56); renumber one in the next docs edit.
- Stale branches for the owner to delete (the proxy blocks deletes): `feat/web-invitation-accept`
  (carries #57's commits and an accidental merge; no PR), `feat/mobile-offline-round-actions`.
- Every merge to main makes open PRs conflict on `docs/CHANGELOG-DEV.md` and the i18n catalogues,
  and a conflicted PR gets no CI run. Merge main into each open PR after each merge.
- In Playwright journeys: find alerts with `page.getByRole("main").getByRole("alert")` (Next's
  route announcer is another alert); root `filter({ has })` locators at `page`; exclude `/…/new`
  when picking links by href prefix.
- Lanes must work only in their own worktree and branch, never rebase or force-push a pushed
  branch, and never bypass the commit hooks.

## Next after the open PRs

Evidence pack part 2c (the public `/p/evidence` routes bound to one link via `app.link_id` in
migration 0058, HMAC codes with a server key, failed attempts counted, live codes capped, the PDF),
the managers' invitation screens, letter and email templates, then slice 12 (family feed and
comms) and slice 13 (search, the free full export, DPIA sign-off, onboarding), then the non-mobile
Phase 1 gate (inspector pack renders, WCAG scans clean, every hazard has a test, safety case v0.1).
