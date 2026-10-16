# Slice 13 search part 4, break-glass search (PLAT-013)

Branch `feat/platform-break-glass-search`.

## What changed

- Migration 0070 (after other lanes' 0067 to 0069): `break_glass_event.kind`; a search names no
  person and lasts no time, so it never widens the break-glass scope. The weekly report keeps to
  openings.
- API: `POST /v1/search/break-glass`: search and break-glass permissions with step-up, a reason
  code and a typed reason, a full name or exact NHS number; across the organisation, at most 10
  people, identity only; a `search` record holding the reason; the Registered Manager of each home
  shown and the data protection lead alerted; a daily limit that tells the data protection lead;
  audited with ids only.
- Web: "Search outside your access" on `/search`: a sheet with the query, the reason code and the
  reason, the passkey notice after a password sign-in, and read-only results.
- Docs: platform-completions.md section 10s (part 4), HZ-011, the register, data standards.

## What is next

- The weekly break-glass report listing searches beside openings; offline search on mobile.

## Human actions logged

- None (the daily limit is a tenant default under H-118).

## Tests

- `apps/api/test/break-glass-search.test.ts` (6); `packages/db/test/search-index.test.ts` (29);
  `apps/web/e2e/break-glass-search.spec.ts` (2, axe on every state).
