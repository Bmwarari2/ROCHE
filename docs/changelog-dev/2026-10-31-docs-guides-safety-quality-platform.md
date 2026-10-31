# User guides: safety, quality and platform

Branch `docs/guides-safety-quality-platform` (Phase 2 slice 83), cut from `main` after batch 2.

## What changed

- 33 new guides and 3 updated. Each covers one task, says who can do it in roles, gives the
  steps as they are on screen (names copied from `en-GB.json`), says what Harbour never does, and
  links the spec rules and hazards.
- **Safety (11):**
  - speak-up: raising a concern, speaking up anonymously, and handling cases;
  - safeguarding: raising a concern, checking measures, and running the log;
  - complaints and compliments;
  - recording a missing person, recording a death, and following up after a death.
- **Quality (15):**
  - the framework, the evidence library and evidence coverage;
  - audit templates, and carrying out an audit;
  - policies: reading and signing, writing and publishing, checking who has signed, and retiring;
  - the quality dashboard and its targets, and the PIR figures;
  - DSPT assertions, submissions and certificates.

  The policy, data security, dashboard and PIR guides describe screens on
  `feat/quality-dashboard-pir`. They say those screens arrive with the next merge.
- **Platform (10):**
  - data rights: the request, finding and reviewing records, sending the response, and erasure,
    correction or portability;
  - breaches, a breach notice from Thapsus, and data protection complaints;
  - import, and undoing an import;
  - single sign-on.

  The three existing data protection lead guides were brought up to date with main's screens.
- The role indexes, the user guides README table and the feature register's user docs column now
  link every guide.

## Found, not fixed here

- **No screens yet**, so no guide:
  - outbreaks and IPC (SAFE-013, slice 63);
  - coroner, police and solicitor disclosures (SAFE-016, H-829).
- **No screens yet**, so the guides say what does exist:
  - the death record and mortality review;
  - the missing person episode and the Herbert Protocol profile;
  - single sign-on.
- **Gaps on screen**, logged as H-1150 to H-1158:
  - a safeguarding concern with protective measures cannot be closed on the web;
  - care workers have no link to raise a safeguarding concern;
  - nobody is alerted when a safeguarding or speak-up concern arrives;
  - the breach notice notification links to the wrong page.

## Human actions logged

- H-1150 to H-1159.

## Tests

- `pnpm check:links`: 301 files, no broken links. Biome does not check Markdown.
