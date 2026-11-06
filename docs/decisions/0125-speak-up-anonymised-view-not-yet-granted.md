---
status: "accepted"
date: 2026-10-31
decision-makers: Claude Code (Phase 2, fixes from the slice 83 guides)
consulted: master prompt section 4 (quality and compliance lead: "whistleblowing (anonymised view)"); ADR-0089; docs/specs/safety.md (speak-up)
informed: Brian
---

# The speak-up anonymised view is not granted until it exists

## Context and problem statement

`safety.whistleblowing.read` ("Read speak-up concerns (anonymised)") is the master prompt's
"whistleblowing (anonymised view)" for the quality and compliance lead. The built-in owner,
Registered Manager, deputy manager and quality lead roles held it, but no API route or screen
reads it. The speak-up silo (ADR-0089) opens concerns only to the Freedom to Speak Up lead and the
members they name. Writing the user guides (slice 83) showed the problem: a permission that opens
nothing suggests managers can see speak-up concerns, and a future screen built on it would open
at once to every existing holder, without anyone deciding that it should.

## Considered options

- Build the anonymised view now (counts by state and category, read through a definer function
  into the silo, with small-number suppression so a count never points at a reporter).
- Keep the permission in the catalogue but grant it to no built-in role until the view exists.
- Delete the permission.

## Decision outcome

Chosen option: keep the permission in the catalogue but grant it to no built-in role
(`NOT_YET_GRANTED` in `packages/domain/src/platform/permissions.ts`). The view needs its own
design and review: which counts it shows, when a count is too small to show, and whether the
Freedom to Speak Up guardian agrees (H-1152). Until then nothing is opened, and nothing suggests
that anything is.

### Consequences

- Good, because no role appears to see speak-up concerns, and the guides and the permission matrix
  say so.
- Good, because the master prompt's intent is kept. The permission is ready for the view.
- Bad, because organisations provisioned before this change keep the permission in their copies of
  the built-in roles. It opens nothing today. The change that builds the view must first remove it
  from those copies (or re-grant it deliberately) before the view reads it.
