# Data rights screens: DSAR workbench, breach register and complaints (Phase 2 slice 66)

Branch `feat/web-data-rights`, from `feat/platform-dsar-workbench` (#149) with
`feat/platform-breach-register` (#156) merged in. PLAT-022.

## What changed

- **Data rights** in the menu, for holders of `quality.dsar.manage` across the whole organisation
  (a Registered Manager or deputy for one home is not offered it; the API and row-level security
  refuse them anyway). Tabs for requests, breaches and complaints under `/data-rights`.
- **DSAR workbench**:
  - The requests list shows each clock as an icon, a word and a sentence ("Respond by …",
    "Overdue: the response was due on …").
  - Recording a request: whose information, who is asking and their authority, how and when it
    arrived, whether identity must be confirmed.
  - The request page follows the work: confirm identity (the clock starts), pause and restart,
    extend, find the records with **Not searched: check these yourself** first, review each
    record, then check and record the response.
  - The record page (step-up) marks other people's names with a bold underline and the words "Name
    of another person", lists them, and takes the decision: send, send with parts taken out (the
    parts and a reason) or hold back (a reason). The record's fingerprint goes with it.
  - The response page (step-up) shows the counts, the fingerprint and each record, offers the file
    to send (a web download route that keeps nothing), and records the outcome. A closed request
    offers exactly what was sent.
  - Erasure is checked against retention; portability says whether it applies.
- **Breach register**: the ICO clock in words from the API's clock and `reportHours` (no figure in
  code), the stage as a chip, and assessment, Harbour's suggestion (decision support only),
  decision, ICO report, notice to the people affected (prefilled from the template), closing and
  Thapsus notices, each offered only while it applies.
- **Data protection complaints**: the acknowledgement and next-update clocks in words; recording,
  acknowledging, updates and closing with the ICO right stated.
- **API fix (belongs in #149)**: the DSAR record view and bundle read whole rows with `to_jsonb`,
  which the invitation table's column grants refuse (42501), so opening or sending any member of
  staff's records failed. They now read only the exported columns. Test in `apps/api/test/dsar.test.ts`.
- **Merge of #156 into #149**: both migrations kept (0077 then 0082, 0082's journal time moved
  after 0077's and its snapshot chained onto 0077's), both routers, contracts and schema modules,
  and both sides of the specs; OpenAPI and client types regenerated.
- Guides: handle a data rights request, record and handle a data breach, handle a data protection
  complaint (data protection lead).

## Not built yet

- A request from a person's contact about their own information (the API takes it; the form does
  not offer contacts yet).
- Recording rectification decisions (the API takes them; the screen says to ask support).
- Correcting a breach's facts; linking a complaint to a person, a location or a breach; names of
  the decider and acknowledger (shown by time only).
- A collected record that no longer exists cannot be decided, so the response cannot be issued
  (API: a decision needs the record's fingerprint; H-881).
- A quality lead without `platform.user.manage` cannot pick a member of staff as the subject (the
  members list needs it); the form says to ask the owner. An API list of subjects for DSAR holders
  would close this.
- Table and field names on the request and record pages are made from the database names ("Care
  note"); the export catalogue's descriptions are not served to the web yet.

## Human actions logged

- H-880: the DPO lead reviews the screens' wording before a tenant uses them.
- H-881: how a record that no longer exists is treated in a response.
- H-882: whether the bundle needs a readable PDF cover.

## Tests

- Unit: `apps/web/src/lib/dsar.test.ts`, `data-rights.test.ts`, `breaches.test.ts`,
  `dp-complaints.test.ts` (table-driven, PLAT-022); the whole web suite, i18n catalogue tests,
  Biome and typecheck.
- API: `apps/api/test/dsar.test.ts` (column grants), `data-protection-registers.test.ts`,
  `export-worker.test.ts`; database: migration journal, sample data, data rights and data
  protection registers.
- E2E with axe in light and dark, run locally against the full stack: `dsar.spec.ts`,
  `breaches.spec.ts`, `dp-complaints.spec.ts`; DPIA, sample data and smoke journeys still pass.
