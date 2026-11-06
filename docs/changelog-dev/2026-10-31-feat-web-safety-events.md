# Web: outbreaks, deaths, missing persons and disclosure (Phase 2 slice 63)

Branch `feat/web-safety-events`, cut from `feat/safety-deaths-missing` with
`feat/safety-outbreaks-ipc` and `feat/safety-disclosure-requests` merged in. Register rows SAFE-013
to SAFE-016.

## Merge

- The drizzle journal keeps every entry, sorted by idx, with `when` strictly increasing. The
  entries for 0081 and 0103 were moved forward.
- Migration 0099 redefined `app.sample_removal_tables()` without the `outbreak_case` that 0093
  added. It now keeps it.
- `biome.json` lost a duplicated `maxSize`.
- `safety.md` had two section 11s, so disclosure requests are now section 12.

## What changed

- Screens on the existing API, described in `safety.md` ("Web screens (Phase 2 slice 63)"):
  - outbreaks;
  - deaths, opened from a death exit record on the leaving tab;
  - missing persons, opened from a missing-person incident, with a Herbert Protocol tab;
  - disclosure requests, including the review of each collected record.
- Navigation: Outbreaks, Deaths, Missing persons and Disclosure requests, each shown only to those
  who may use them.
- API checks added after the clinical safety review (no migration):
  - an outbreak refuses a second current line-list row for a person;
  - a death record refuses the police steps as not needed before the clinician's judgement;
  - a first Herbert profile with prefilled parts needs `prefillChecked`.
  OpenAPI and the client are regenerated.
- The web shows the API's own sentence for a refusal the record's state makes (`invalid_state`),
  for example closing an outbreak before its report is decided.
- `e2e/support.ts` (`settleAnimations`) no longer waits on animations nobody can see. Chromium hides
  a closed `<details>` with content-visibility, and a transition there never ends.
- Strings: 391 new keys and 12 changed (en-GB, ICU, sentence case), marked untranslated in Welsh.
- Docs:
  - the hazard log: HZ-013 and HZ-127 controls, causes and tests;
  - `safety.md`;
  - the feature register;
  - human actions H-950 to H-958.

## Reviews

The accessibility and clinical-safety reviewer agents both ran. All their findings are fixed, apart
from the decisions left for the CSO (H-950 to H-954). The clinical ones:

- a police call missed before the person was found is said as missed;
- the call wording never invites waiting;
- the episode page refreshes itself;
- a prefilled Herbert profile is checked before saving;
- the police steps stand until the judgement;
- outbreak cases are updated by superseding, never added twice;
- staff cases are marked not collected;
- closing with people still unwell needs confirming;
- retries keep their ids.

## Tests

- Unit:
  - web: `outbreaks`, `deaths`, `missing`, `disclosures` and `outcome` tests;
  - domain: `death-record.test.ts`;
  - API: `outbreaks.test.ts` and `deaths-missing.test.ts` (the new HZ-013 and HZ-127 cases).
- Playwright, all passing locally with axe in dark and light:
  - `outbreaks.spec.ts`: declare, record and update a case, closing refused until the report;
  - `deaths.spec.ts`: the list and the open page;
  - `missing.spec.ts`: open an episode with the police call first, record the call, the Herbert
    tab;
  - `disclosures.spec.ts`: log, collect, review a record.

## Not done

- Staff cases on the line list need a staff list (H-955).
- A death record page journey: making one would mark a demo resident dead for every journey.

## Recommended answers applied (31/10/2026)

- H-950: the death record refuses the regulator's death notification, the medical examiner
  information and LeDeR as done or not needed; only the notification centre settles them, and a
  "not needed" recorded on the record earlier never counts (HZ-013 row and tests updated).
- H-958: a released disclosure pack is downloaded once as a PDF carrying its fingerprint, with a
  fresh step-up and an audit event, through `/disclosures/{id}/pack`; the hand-over is then recorded
  once with its date, a secure route (never ordinary email) and the recipient's reference. Migration
  0103 gains the columns and guards (this branch only).
