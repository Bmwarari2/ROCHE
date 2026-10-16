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
| #45, #46, #47 | Downtime pack API: rebuilt when anything it shows changes or someone moves, a PDF never stored, step-up and an hourly limit on whole-home access, nightly packs and the paper places (0055) |

## Open work

- **3c `feat/operations-outages-api` (Lane A), head 0736fff:** the outage routes, tests, OpenAPI
  and docs, marked work in progress, with no PR. Merge main in, finish it and open the PR, then 3d
  (back-entry on the care routes, sending a refused second correction to the refused-entry review,
  HZ-006).
- **#50 (draft, Lane C, mobile), head 6476f23:** parked mid round 1 fixes.
  - Done:
    - `4c294aa`, security M1: handovers reach only where incidents, notes and the person can also be read, recorded in ADR-0071.
    - `6476f23`, work in progress: clinical M1 to M3 (no acknowledgement in alert summaries, the trigger's reason carried, the plan action and earlier-plan flag on task summaries).
  - Not started:
    - clinical M4 (the shift claim's wording, operator log and HZ-018 tests);
    - the docs for M1 to M3;
    - every Low, including disabling the triggers during the 0056 backfill and the no-tenant guards.
  - `feat/mobile-round-screen` (`a4ab5fe`) holds unreviewed round-screen work. Leave both while mobile is paused.
- **Lane B:** next is the statutory notification pages; its earlier start is in `wip/`.
- **Lane D:** next is the invitation routes and accept page, then the MFA session-factor fix.

## Ids in use

Migrations to 0055 on main (0056 for draft #50). Human actions to H-260. STATUS items to
20. Hazards: lanes take HZ-080 to HZ-119 by range.

## Build tracker

https://claude.ai/artifact/7c8zgg7CZYHZSh3WY32qtV (ArtifactData; read, then write with
`if_version`). `meta/status` is at version 27 or later; step `p1-b10` (Offline Care mode) says
paused.
