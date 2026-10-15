# Harbour: handover (16/10/2026)

Start from `NEXT-SESSION-PROMPT.md` in this folder; it carries the owner's standing instructions.
The lane briefs (`lane-rules.md`, `lane-a.md` to `lane-d.md`) still describe how lanes work.

## Decisions by the owner this session

- **Mobile apps paused (16/10).** No work on `apps/mobile`, the phone streams or the screens
  gate until the owner says so.
- **Cost:** the account hit its session limit (13/10) and its weekly limit (13/10, reset 15/10
  23:00 UTC). Run at most two build lanes plus reviewers.
- **Repository public again (15/10)** after a spell as private stopped every Actions job for
  billing.

## Merged since the last handover

| PR | What |
| --- | --- |
| #32, #33 | Downtime pack and outage schema (0050, 0051); phone task and handover sync streams (0052) |
| #34, #35 | Web consent, capacity and DoLS tab, parts 1 and 2 |
| #36, #37 | Phone: offline task moves and handover acknowledgements, and their upload (a stale move is set aside, never replayed) |
| #38 | Back-entry columns on the five care tables (0053) |
| #39, #40 | Feature flags through one provider; admin sign-out and idle timeouts (timeouts ship off) |
| #42, #49 | Web incidents list and read view; statutory notifications on the incident page |
| #43, #48 | Invitation and MFA enrolment rules; the invitation store (0054) |
| #44 | Shared allergy, communication and rate helpers; commitlint ignores "Merge " commits |

## Open work

- **#45, #46, #47 (Lane A, the downtime pack and API, stacked: #45 on main, #46 on #45, #47 on
  #46).** Round 1 found 2 Highs and 9 Mediums; the full fix list was sent to Lane A:
  - #45: H1, rebuild when any source changed (a source fingerprint against `as_at`); a limiter,
    an advisory lock and reuse when nothing changed; step-up on POST; a fallback to the latest
    pack if a rebuild fails; outage wording uses the earlier of `as_at` and the outage start.
  - #46: step-up and a limiter on `?format=pdf`; the identity instruction for everyone until
    photos print; "ADRT also held"; header times with the BST/GMT marker; audit "printed" after
    rendering.
  - #47: H2, `bed-moves` publishes `people.person.moved` and the pack rebuilds for both homes
    (test through the real route); each outbox handler in its own try/catch; a task for the
    Registered Manager when a home has no in-date pack; renumber the migration to 0055.
  - Then round 2 on the fix commits only, and merge in order. Check this note against the
    branches: if the session stopped mid-fix, the worktree may hold staged work.
- **3c `feat/operations-outages-api` and 3d** (Lane A): not opened yet.
- **#50 (draft, Lane C, mobile):** parked with its round 1 fixes unfinished (1 security Medium on
  module permissions behind `care.handover.manage`; 4 clinical Mediums on summary wording).
  `feat/mobile-round-screen` holds unreviewed round-screen work. Leave both while mobile is paused.
- **Lane B:** next is the statutory notification pages; its earlier start is in `wip/`.
- **Lane D:** next is the invitation routes and accept page, then the MFA session-factor fix.

## Ids in use

Migrations to 0054 on main (0055 for #47, 0056 for #50). Human actions to H-260. STATUS items to
20. Hazards: lanes take HZ-080 to HZ-119 by range.

## Build tracker

https://claude.ai/artifact/7c8zgg7CZYHZSh3WY32qtV (ArtifactData; read, then write with
`if_version`). `meta/status` is at version 26 or later; step `p1-b10` (Offline Care mode) says
paused.
