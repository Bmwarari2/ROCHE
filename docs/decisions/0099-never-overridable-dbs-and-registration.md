---
status: "accepted"
date: 2026-10-31
decision-makers: Claude Code (Phase 2 lane C), on the CSO's recommended answer (H-830)
consulted: master prompt section 12 (rules); docs/plans/recommended-answers.md (H-830); DBS Adult First guidance; NMC register
informed: Brian, the CSO (review at testing)
---

# No DBS certificate and a lapsed registration are never overridable

## Context and problem statement

Master prompt section 12 says a worker without the required DBS result, right to work or competence
"cannot be rostered to a shift that needs it (manager override with justification is logged and
reported)". Slice 21 followed it: every blocker except the right to work and a member not active
could be overridden. The recommended answer to H-830 (applied 31/10/2026, reviewed at testing) is
that two more must never be overridden. A member with no DBS certificate at all has a lawful route
to a supervised start: an Adult First check with a signed risk assessment, which Harbour already
models as `dbs_supervised_only`. A registrant whose registration has lapsed may not work in the
registered role at all. An override in either case would let a manager do what the law or the
regulator does not allow.

## Considered options

- Keep the master prompt's override for these two blockers.
- Make both never overridable, in the domain and in the database.

## Decision outcome

Chosen option: make both never overridable. This departs from master prompt section 12, and this
ADR records the departure.

- `neverOverridable` covers `dbs:no_certificate` and `registration`, alongside the right to work and
  a member not active. The rota refuses with `no_dbs` or `registration`, and the words say it cannot
  be overridden.
- The database refuses an override naming either key (`roster_override_never_allowed`, migration
  0107's guard), whatever the API does.
- Other DBS blockers, such as a disclosure not yet assessed or new information from the Update
  Service, stay overridable with a justification, and the override is logged and reported.
- Supervised and shadowing shifts and templates no longer count as care unless the organisation
  says so: `countsAsCare` defaults to false when `supervised` is true.
- The CSO's ratings for HZ-123 and HZ-124 are recorded in the hazard log.

### Consequences

- Good: a manager cannot roster someone the law or the regulator bars, and an Adult First check
  stays the lawful way to start someone on supervised shifts.
- Bad: a home short of staff cannot use an override to get past either blocker. It must find
  someone else, or arrange a supervised start.
