# DoLS needing attention at a location (CARE-022, for INSI-001)

Branch `feat/api-location-dols`.

## What changed

- API: `GET /v1/locations/{id}/dols` lists DoLS records needing attention at a location, for the
  people the reader may see. That means requests still waiting for an outcome, authorisations
  inside the first reminder window, and authorisations past their end with nothing recorded since.
  The list runs ending soonest first, with requests last. It needs `care.plan.read`, uses
  row-level security for scope and is audited by location only. It is additive: no migration and
  no change to existing routes. OpenAPI and the typed client are regenerated.
- Why: the role dashboards (INSI-001) can then show a request with no outcome. Such a request has
  no end date, so the expiry reminders never cover it (HZ-020).
- Docs: `docs/specs/care.md` (the DoLS paragraph), and a control and a verification row under
  HZ-020 in the hazard log.

## What is next

- The dashboards branch (`feat/web-dashboards`) can use it for its DoLS tile.

## Human actions logged

- None.

## Tests

- `apps/api/test/location-dols.test.ts` (5): order and filter, a care worker's scope, another
  organisation, a member with no role, and the audit entry. `route-gates`, `mca` and
  `scope-per-permission` still pass (65).
