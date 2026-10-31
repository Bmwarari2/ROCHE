# Slice 31: outbreaks and IPC audits (SAFE-013)

Branch `feat/safety-outbreaks-ipc`, stacked on `feat/quality-audit-programme` (slice 19), with
`main` merged in for #137 (the slice 7 safety rules).

## What changed

- Domain (`packages/domain/src/safety/outbreak-management.ts`, table-driven tests):
  - case rules (`checkOutbreakCase`) and the current row per person;
  - the UKHSA report fields from the line list, listing what is missing (`ukhsaReportFields`);
  - closure only once the report is decided (`checkOutbreakClosure`, HZ-013);
  - the 10 Code of Practice criteria, with `checkIpcTemplate` and `ipcCriteriaResults` for IPC
    audits.
- New permission `safety.outbreak.manage`, a care-record permission, so MFA applies. The owner,
  Registered Manager, deputy and clinical lead hold it.
- Database, migration 0093 (self-contained, forced RLS):
  - `ipc_code_criterion`: global and seeded.
  - `outbreak`: scoped by location. It is declared open in the declarer's name, with one open
    outbreak per illness at a location. It closes once, and only when its report is decided.
  - `outbreak_case`: append-only. Residents of the location and members of staff appear once
    each; later rows supersede the current one. A resident's row is seen only where the person
    is visible.
  - The IPC starter now has 13 questions covering all ten criteria.
  - Sample removal includes outbreak cases.
  - Existing tenants' built-in roles gain the permission, audited.
- API (`apps/api/src/routes/outbreaks.ts`, audited with ids only):
  - criteria, and an IPC audit read against them;
  - list, declare, read (view audited), update, add or supersede a case, close.
  - Declaring drafts the outbreak's own UKHSA report, due without delay, so the clock shows in
    the notification centre. The report fields are counted from the whole line list and shown on
    the outbreak; Harbour never writes into the report.
  - IPC templates are checked against the criteria when saved.
  - OpenAPI and the client are regenerated.
- `biome.json`: `files.maxSize` is now 4 MiB. The raw generated client passed 1 MiB, so Biome
  stopped formatting it.
- No web screens; those come in slice 63.

## Docs

- safety.md section 11.
- Permission matrix.
- HZ-013: a design control and verification. HZ-011: verification.
- Medical-device boundary: re-checked and unchanged; a paragraph added for slice 31.
- Records of processing: an outbreaks and line list row, covering health data including staff
  health.
- Data standards, retention and the feature register.

## Review rounds

- Round 1 (security and clinical-safety reviewer agents):
  - **Reports are never shared.** Each outbreak drafts its own report. The database holds one
    outbreak per report, and an outbreak never closes without its report.
  - **No writes into a report's content.** Harbour no longer writes it, so a preparer's answers
    are never overwritten. The fields stay on the outbreak.
  - **Detection cut-off per illness.** Deciding a report resets detection only for its own
    illness, and a declared outbreak's report never resets it. This changes
    `locationInfectionCases`.
  - **Report counts.** They are counted from every row whoever is reading; the reader sees how
    many rows are not shown. Anyone ever positive or in hospital stays counted.
  - **Updates follow their row.** An update follows the row it supersedes after a discharge,
    move or leaving.
  - **Staff cases.** Staff must hold a current role at the location or organisation-wide.
  - **England only.** Declaring is refused outside England until the nation pack loads.
  - **Closure dates.** Closure is refused before the declaration's UK date, with its own message.
  - **New tests.** Scoped readers, other organisations' people and staff, moves, the no-delete
    grant, and per-illness detection.
  - **For the CSO.** Asymptomatic cases (H-783), "ever" counts (H-784), immediate escalation
    (H-785), and reconciling detection and declaration reports (H-786).

## Human actions logged

- H-765: the criteria wording.
- H-766: the IPC starter.
- H-767: the lawful basis and retention for staff cases.
- H-768: the closure rule.
- H-769: the report fields against the health protection team's form.
- H-780: default holders of the permission.
- H-781: the devolved nations.
- H-782: agency staff on line lists.
- H-783 to H-786: CSO decisions from review round 1.

## Tests

- `packages/domain/src/safety/outbreak-management.test.ts`: 40 tests.
- `packages/db/test/safety-outbreaks.test.ts`: 16 tests.
- `apps/api/test/outbreaks.test.ts`: 16 tests.
- `apps/api/test/incidents.test.ts`: plus one (per-illness detection).
- Updated: `rls-coverage.test.ts` (`outbreak_case` is append-only) and `sample-data.test.ts`
  (`outbreak` refers to a removable notification and is listed as stopping removal).
