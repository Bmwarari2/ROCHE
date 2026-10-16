# Slice 13 search part 2, the search route (PLAT-013)

Branch `feat/platform-search-api`, PR #93, stacked on #91.

## What changed

- API: `POST /v1/search`: the words in the body only; `buildSearchPlan` with the session's MFA, the
  role end and the agency flag (no shift recorded until rotas: refused); each kind read in its own
  permission's scope (ADR-0071) with break-glass left out; `filterSearchResults` again, people first
  with same-name warnings; an alarm with counts only if the plan drops a row; audited with the ids
  shown, refusals with the problem, never the words.
- Docs: platform-completions.md section 10s (part 2), HZ-011, the register, STATUS, rates.md
  (`search.requests_per_minute`).

## What is next

- The search page (#94), then break-glass search with `break_glass_event.kind`.

## Human actions logged

- None (`search.requests_per_minute` is a tenant default under H-118).

## Tests

- `apps/api/test/search.test.ts` (14).

## Review rounds

- Round 1: corrected notes, deleted people and colleagues outside the staff scope are left out in
  SQL, so routine searches drop nothing and raise no alarm (now also an audit event); every query
  orders best matches first before its limit and says when results are capped; a per-member limit
  from the rate table and a statement timeout; a member whose row cannot be read is refused;
  communication needs on person results.
- Main and #91 merged; this entry moved here from `docs/CHANGELOG-DEV.md` (ADR-0073).
