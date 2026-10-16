# Sample data on the web (PLAT-018, HZ-072)

Branch `feat/web-sample-data`, PR #NN. No migration.

## What changed

- The onboarding page has a "Sample data" section. It says whether sample data is loaded and
  offers "Load sample data" only while the organisation has never had a real person. It offers
  "Remove sample data" while a batch is in place. Each asks for confirmation and says what will
  happen. Removal needs a fresh step-up. Refusals are said in plain words from the catalogue
  (`onboarding.sample.refusal`).
- A banner shows on every screen while sample data is in place (`Banner` variant `sample` in
  `@harbour/ui`: an icon and words, polite), with a link to the controls for those who may manage
  them.
- Each sample person carries the "Sample" badge, an icon and a word, beside their name: the people
  list, the record header, the compact header on rounds and handovers, and search results.
  Incidents, statutory notifications and the new incident form name them as "(Sample)".
- The API adds `sampleData` to `GET /v1/me`, `sample` to each person summary and search result,
  and `sampleData { present, mayLoad }` to the onboarding checklist.
- The end-to-end seed adds "Starter Example Care", an empty organisation with its own owner and
  passkey, because sample data only loads where no real person has been added.
- Tests: the Playwright journey `e2e/sample-data.spec.ts` runs axe on every state. There are also
  unit tests for the badge, the name marker and the refusal words. The full Playwright suite
  passes (89).

## What is next

- The mobile badge and banner, once mobile sync resumes.
- Sample flags on records about sample people, for the other surfaces.
