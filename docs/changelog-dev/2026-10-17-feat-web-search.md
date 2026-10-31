# Slice 13 search part 3, the search page (PLAT-013)

Branch `feat/web-search`, PR #94, stacked on #93.

## What changed

- Web: `/search` and "Search" in the side bar for `platform.search.use`: the box (with "Look in"
  and, for those who may, people who have left), results that take focus and say where the search
  looked and what it left out, people with photo, date of birth or age, NHS number, communication
  needs and status as a word, same-name warnings, and refusals in words. The words never reach the
  address. Strings in en-GB; Welsh copied and listed as untranslated.
- Docs: platform-completions.md section 10s (part 3), HZ-001, the register, STATUS.

## What is next

- Break-glass search with its dialog and `break_glass_event.kind`; offline search on mobile.

## Human actions logged

- None.

## Tests

- `apps/web/src/lib/search.test.ts` (7); `apps/web/e2e/search.spec.ts` (4, axe on every state).

## Review rounds

- Round 1: the form posts, so pressing Enter before the scripts load never puts the words in the
  address (an end-to-end test with scripts off); communication needs on person results; the
  same-name warning in the warning style, its words matching what is shown (date of birth or age);
  "Searching" announced; a capped search asks for another word; axe on the refusal, people who have
  left, and same-name states (two invented residents with the same name at the Mews, seeded for local
  end-to-end tests only). The MFA notice cannot be reached in the local journeys, where the demo
  tenant runs without MFA; the API test covers the refusal.
- Main and #93 merged; this entry moved here from `docs/CHANGELOG-DEV.md` (ADR-0073).
