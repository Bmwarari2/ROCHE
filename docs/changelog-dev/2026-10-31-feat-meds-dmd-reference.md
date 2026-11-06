# Phase 2 slice 10, dm+d reference data (MEDS-001, INTG-006)

Branch `feat/meds-dmd-reference`, pull request not yet opened.

## What changed

- Spec first: [integrations.md](../specs/integrations.md) section 11 (schema, permissions, rules 1 to
  10, the release source port, API and test list), with pointers from medicines.md and
  data-standards.md (the dm+d and GTIN code lists).
- Domain, `packages/domain/src/medicines/dmd-release.ts`: the release content types,
  `checkDmdRelease` (identifiers, references, lookup codes, GTINs and dates, the first 50 problems
  kept with the count), `dmdReleaseOrder` (never backwards, never twice), `dmdReleaseFreshness`
  (out of date past the rate table's limit), `isGtin` and `toGtin14`, `dmdSearchQuery` (a code
  checked, never a near match; words as prefixes), `dmdDoseUnitCodes` and `dmdProductFacts` (the
  units and routes dm+d gives, for `checkDose`). `dmd-subset.ts`: `selectDmdDeviceSubset`, the rows a
  location's devices need (slice 68 streams them). `packages/domain/src/integrations/
  dmd-release-source.ts`: the release source port.
- Schema, migration 0110 (one file with its security SQL): `dmd_release`, `dmd_lookup`, `dmd_vtm`,
  `dmd_vmp`, `dmd_amp`, `dmd_vmpp`, `dmd_ampp`, `dmd_gtin`, global with no `tenant_id`, forced RLS
  with a read policy for every role, SELECT only for the application, worker and sync role, no
  deletes (triggers), in the PowerSync publication. Writes only through `app.dmd_begin_release`,
  `app.dmd_load_rows`, `app.dmd_finish_release` and `app.dmd_record_refusal`, owned by the new
  NOLOGIN role `harbour_dmd_loader` (bootstrap; H-656) and executable by the worker and the owner.
  Each outcome is also a platform event in the audit chain. `rls-coverage.test.ts` gains a list of
  national reference tables with why; `definer-acls.test.ts` lists the loader's callers; the export
  catalogue marks the tables `not_exported`.
- Loader, `packages/db/src/dmd/`: reads the NHSBSA XML with `saxes` (ISC; no document type
  declaration), checks the release whole, writes it in one transaction in batches (changed rows
  only), refuses an older or shrunken release, links identifiers dm+d changed to their successors,
  withdraws GTINs a release lacks, and records refusals with their problems. `pnpm --filter
  @harbour/db dmd:load` for a manual run. An invented fixture (two releases) under
  `packages/db/test/fixtures/dmd/`.
- API: `GET /v1/medicines/dmd/products`, `/products/{id}`, `/gtin/{gtin}` and `/releases`, for any
  of `medicines.record.manage`, `medicines.emar.administer` and `medicines.stock.manage`; every
  response carries the release in use and whether it is out of date. The mock release source and
  the monthly `dmd-release-load` worker job; production has no source until slice 75. OpenAPI and
  the typed client regenerated.
- Rates: `medicines.dmd.stale_after_days` (35, `to-verify`, H-651).
- Clinical safety: HZ-113 added, every code control with a `hazard HZ-113` test; HZ-005 gains the
  reference data control and its test; the medical-device boundary re-checked and recorded
  (reference data only, no dose rules). ADR-0080 (proposed).
- Data protection: no personal data; TRUD recorded as a download source, not a sub-processor.
- Migration numbers: slice 10 takes 0110 (0072 can no longer apply after 0088 in journal order, so
  it is retired) and slice 76 moves to 0111, as phase-2.md allows, recorded in its table.

## Review

The clinical-safety and security reviews (run in this session against the reviewer agents' briefs)
found, and this branch fixes:

- Clinical, medium: a name search offered a product whose identifier dm+d had replaced, so a new
  MAR entry could be written with the old identifier. Superseded products are now left out of a
  name search unless asked for, and shown marked when their code is typed (test added).
- Clinical, low: the GTIN lookup returns invalid packs marked while the device subset leaves them
  out; the difference is now stated in the spec and HZ-113, and HZ-005 lists the new units test.
- Security, medium: loads were in the release history but not in the audit chain (section 5.5);
  each load, refusal and failure is now a platform event, readable by the operator only (test
  added).
- Security, medium: the mock source keyed only on `NODE_ENV`, so a staging or pilot environment
  running from source could load the invented fixture where real people work; it now also refuses
  on `HARBOUR_ENV` staging, pilot or production, as does the manual script (test added).
- Security, low: a broad prefix search scans a whole release; the search is now bounded to 5
  seconds, as platform search is.

## What is next

- Slice 75: the TRUD download behind the port (credentials, checksum, alert on refused, failed or
  out of date), after H-510, H-511 and H-654.
- Slice 16: the medicines record uses `dmdProductFacts` and the product lookup; slice 22 matches a
  scan to the MAR entry (ADR-0081); slice 52 the picker with the release date and warning; slice
  68 streams the device subset.
- Human actions H-657 to H-659 are spare.

## Human actions logged

- H-650 (CSO): HZ-113 and the boundary reading; H-651: the out-of-date limit; H-652 (pharmacist):
  the dose units offered; H-653: what happens when a real release is refused; H-654: a first real
  load outside Git; H-655: whether invalid products may ever be chosen; H-656: bootstrap before 0110.

## Security review round 2

The coordinator's security review of feb3840d found nothing critical or high. Fixed on this branch,
each with tests (migration 0110 edited in place, as it is not on `main`):

- Medium: the fixture guard depended on the operator's shell. Each database now carries a mark
  (`app.database_environment`): the deploy's migrate task writes `HARBOUR_ENV`, `pnpm db:migrate`
  writes `dev` only for a database on this machine, test databases are `test`, and a database once
  marked anything else can never be marked `dev` or `test` again or unmarked. The loader and
  `app.dmd_begin_release` refuse a release named `fixture_...` or loaded as `fixture` unless the
  mark is `dev` or `test`, whatever source it claims.
- Medium: no size or time limits. The worker's `DMD_RELEASE_MAX_FILES`, `DMD_RELEASE_MAX_BYTES` and
  `DMD_LOAD_TIMEOUT_MINUTES` bound a load; directories and files that are symbolic links are
  refused (`lstat`, `O_NOFOLLOW`); each file is streamed through `saxes` in chunks, yielding to the
  event loop between them, never read whole; every statement runs only for the time the load has
  left; the job has its own `exclusive` queue worked one job at a time. A process of its own for
  the load is recorded for slice 75.
- Low: a release dated more than 3 days ahead of today is refused, in the loader and the database.
- Low: `app.dmd_finish_release` no longer takes the caller's identifiers: what a load wrote is noted
  in temporary tables named after the release and owned by `harbour_dmd_loader`, which the caller
  cannot write, and finish works out the release (and its counts) from them.
- Low: the four loader functions' search path ends in `pg_temp`; the other definer functions are a
  separate chore.
