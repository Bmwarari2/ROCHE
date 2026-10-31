---
status: "accepted"
date: 2026-10-31
decision-makers: Claude Code (Phase 2 lane E, slice 47)
consulted: master prompt sections 4, 5.3 and 11.2; docs/plans/phase-2.md (slice 47); ADR-0002; ADR-0071
informed: Brian
---

# Quality indicator counts: one definer function returning numbers only

## Context and problem statement

The quality dashboard (QUAL-005) and the PIR prefill (QUAL-006) need counts per location from
other modules' tables: incidents (safety), body map marks, care plans and risk assessments (care),
bed occupancy (people) and incident workflow transitions (platform). Plan slice 47 says the counts
should come "from events the source slices publish", but no source slice publishes such events
yet, and section 6 says modules talk through outbox events with no cross-module joins.

A manager reading the dashboard under their own row-level security would also get the wrong
figure. Incidents are visible through the people they involve, so an incident at a home involving
someone who now lives elsewhere drops out of that home manager's count. An undercount reads as
good, which is hazard HZ-129.

## Decision drivers

- A figure must be complete for the location, or not shown (rule 22, HZ-129).
- Nothing personal may leave the database for a dashboard: counts, not rows (section 5.1).
- Access is checked in the API and again in Postgres (ADR-0002).
- Slice 47 must not wait for event read models that do not exist.

## Considered options

- Count under the reader's own row-level security in the API.
- Count in the API under the organisation's system context, after an API permission check.
- One security-definer function, owned by a no-login role, that checks the permission itself and
  returns numbers only.
- Wait for the source slices to publish events and build a read model.

## Decision outcome

Chosen option: the definer function, `app.quality_indicator_counts(location, from, to,
target_days)`, owned by `harbour_quality_reader`, executable by `harbour_app` only. Of the options
that can ship now, it is the only one that gives complete counts while the database itself
refuses a caller without `quality.audit.manage` at the location. The owning role holds SELECT on
exactly the columns counted, plus the role tables the permission check reads; the tenant policy
still applies to it. The function returns one JSON object of numbers and dates.

This deviates from the plan's "from events": the counts are read where the records are. When the
source slices publish events, a read model can replace the function's queries without changing the
API, the rules or the contracts.

### Consequences

- Good, because counts are complete for the location, whatever the reader's own row scope.
- Good, because the database refuses the call without the permission, and no row, name or id
  leaves it.
- Good, because the reads are in one reviewed place, listed in the definer ACL test.
- Bad, because one function reads several modules' tables. A change to those tables must update
  it, and the API and database tests catch a mismatch.
- Bad, because the counts are computed on each read. Sized for one location and up to 366 days,
  this is within budget for the pilot; a read model is the next step if it is not.

## More information

quality.md section 22; migration 0108; `packages/db/test/quality-indicators.test.ts`;
`apps/api/test/quality-dashboard.test.ts`; hazard HZ-129.
