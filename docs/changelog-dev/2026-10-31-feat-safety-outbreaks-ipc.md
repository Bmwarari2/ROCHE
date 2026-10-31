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
  - Declaring links the location's UKHSA report still being prepared, or drafts one due without
    delay, so the clock shows in the notification centre. The report's content is filled from
    the line list while it is prepared.
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

## Human actions logged

- H-765: the criteria wording.
- H-766: the IPC starter.
- H-767: the lawful basis and retention for staff cases.
- H-768: the closure rule.
- H-769: the report fields against the health protection team's form.
- H-780: default holders of the permission.
- H-781: the devolved nations.
- H-782: agency staff on line lists.

## Tests

- `packages/domain/src/safety/outbreak-management.test.ts`: 37 tests, 100% lines.
- `packages/db/test/safety-outbreaks.test.ts`: 11 tests.
- `apps/api/test/outbreaks.test.ts`: 14 tests.
- Updated: `rls-coverage.test.ts` (`outbreak_case` is append-only) and `sample-data.test.ts`
  (`outbreak` refers to a removable notification and is listed as stopping removal).
