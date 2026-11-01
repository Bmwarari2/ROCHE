---
status: proposed
date: 2026-10-31
decision-makers: Claude Code (lead engineer), taking the Phase 2 plan's default; security reviews it, the CSO and a pharmacist confirm the clinical points (H-650 to H-653), Brian the licence and the account (H-510, H-511)
consulted: master prompt sections 5.2, 5.3, 10.2, 15.3, 17.1 and 19; docs/plans/phase-2.md (ADR table, slices 10, 68 and 75); docs/specs/integrations.md section 11; docs/specs/medicines.md rules 1 and 2; docs/compliance/medical-device-boundary.md; ADR-0002, ADR-0070
informed: everyone working in this repository
---

# dm+d reference data: source, licence, refresh and the device subset

## Context and problem statement

Every medicine Harbour records is a dm+d product (medicines.md rule 1, HZ-005): the MAR names a
VMP, and an AMP when a brand matters; a dose must be in a unit dm+d gives for the product (rule 2);
a barcode check matches a pack's GTIN to the MAR entry (ADR-0081, slice 22). Slice 2 built the
identifier rules but nothing says whether a product exists, what it is called, which units and
routes it has, or which pack a barcode names. Where does that data come from, under what licence,
how is it kept current and whole, who may change it, and what does a phone at the point of care
hold? Wrong, stale or half-loaded reference data shows the wrong product, unit or pack (HZ-113).

Section 19 lists "dm+d sync" in Phase 5, while section 15.3 dates it "2–3", the feature register
puts INTG-006 in Phase 2, and the Phase 2 gate needs barcode checks against dm+d. The plan's
default, recorded here, is that dm+d loads in Phase 2; pharmacy feeds stay in Phase 5.

## Decision drivers

- One source of truth for medicines, national and authoritative, never typed by a tenant (HZ-005).
- Whole or nothing: readers must never see half a release, an older release over a newer one, or a
  product a MAR names disappear (HZ-113).
- Least privilege (ADR-0002): the application never writes reference data; a narrow role does.
- Out of date must be visible on every read, never hidden (section 5.2, HZ-002, HZ-113).
- No personal data leaves Harbour for this; real release files never enter Git or tests.
- The medical-device boundary: reference data only, no dose rules, no ingredient comparison.
- Offline at the point of care (section 17.1): a phone holds only what its location needs.

## Considered options

- The NHSBSA dm+d release from TRUD, loaded into global reference tables by a loader role, refreshed
  monthly with a manual run, and a per-location subset synced to devices (chosen).
- A third-party drug database API (a commercial dm+d wrapper) queried at run time.
- Each tenant's pharmacy supplier's product file, imported per tenant.

## Decision outcome

Chosen option: "the NHSBSA dm+d release from TRUD in global reference tables", because it is the
national standard the NHS uses for medicines and devices, it is free to download through TRUD, it
needs no sub-processor and no run-time dependency, and loading
it ourselves lets the database enforce whole-or-nothing, never-backwards and nothing-disappears.

1. **Source and licence.** The NHSBSA dm+d release (data model R2 XML: `f_lookup2`, `f_vtm2`,
   `f_vmp2`, `f_amp2`, `f_vmpp2`, `f_ampp2`) and the supplementary GTIN file (`f_gtin2`), downloaded
   from TRUD with Thapsus's account (H-510). The terms TRUD shows for the release, and those for
   the SNOMED CT UK Drug Extension identifiers dm+d carries, must allow a commercial SaaS product to
   store the release and cache a subset on staff devices; Brian confirms them before any real
   release is loaded (H-511), and this ADR records what he finds. TRUD receives only
   the account's credentials: it is a download source, not a sub-processor.
2. **Storage.** Global tables with no `tenant_id`, like `bank_holiday` (migration 0110):
   `dmd_release` (the release history), `dmd_lookup` (units, forms, routes, controlled drug and
   legal categories), `dmd_vtm`, `dmd_vmp`, `dmd_amp`, `dmd_vmpp`, `dmd_ampp` and `dmd_gtin`. Each has
   forced RLS with a read policy for every role; the application, the worker and the sync role have
   SELECT only; nobody deletes (triggers). Only the loader's SECURITY DEFINER functions write, owned
   by the NOLOGIN `harbour_dmd_loader`; the worker (the job) and the owner (a manual run) may execute
   them, never the application. Ingredients are read only for the units their strengths are given
   in and are never stored (boundary).
3. **Loading.** The loader reads every file, checks the release whole (`checkDmdRelease`), then
   writes it in one transaction under an advisory lock, writing only rows that changed; a release
   left loading cannot commit. A release dated before the one in use is refused; one already loaded
   under its name is not loaded again. dm+d never deletes: a release that lacks a concept in use is
   refused, unless the concept is named as a new concept's previous identifier, when the old row
   points to its successor. A GTIN mapping a release lacks is kept, withdrawn, and never matches
   again. Each refused or failed release is recorded with its problems; the release in use stays.
   XML is read with `saxes` (ISC), streamed a chunk at a time; a document type declaration is
   refused, so no entity expands. A load has limits from the worker's configuration (files, bytes,
   time), refuses symbolic links, and runs on its own queue one job at a time; a process of its own
   is slice 75's. A release dated more than 3 days ahead of today is refused. What a load wrote is
   noted in temporary tables only the loader's role owns, and finish works out from them what the
   release holds, never from the caller.
4. **Refresh.** Monthly, as section 15.3 sets it (the worker's `dmd-release-load` queue, early on the
   3rd), with a manual run (`pnpm --filter @harbour/db dmd:load <directory>`). The TRUD download,
   its checksum and the failure alert are slice 75, behind the `DmdReleaseSourcePort` built here with
   a mock; production has no source until then and the job says so.
5. **Out of date.** Every read returns the release in use, its date and its status: out of date when
   older than `medicines.dmd.stale_after_days` (rate table, 35 days, H-651), read from the national
   row only so a tenant cannot quieten it; no release means nothing can be chosen.
6. **Development and tests** use a small invented fixture (`packages/db/test/fixtures/dmd/`: invented
   products, identifiers in an invented range with valid check digits, GTINs in the GS1
   restricted-circulation range 200), never real release files. It is never loaded where real people
   work: the mock source is off on staging, pilot and production, and the database itself refuses a
   release named `fixture_...` unless it is marked `dev` or `test` (`app.database_environment`,
   written by the deploy's migrate task from `HARBOUR_ENV`; a database once marked for real use is
   never marked `dev` or `test` again).
7. **The device subset.** Each device holds only the products on its location's MARs, the products
   that replaced them, every valid brand and pack that could be in the person's hand (only the named
   brand's packs when the MAR names one), the GTINs in force on them, and the lookups those rows
   name (`selectDmdDeviceSubset`); invalid brands and packs, withdrawn and ended GTINs are left out,
   and a product the MAR names that the data lacks is reported so the device can say so. The tables
   are in the PowerSync publication with SELECT for the sync role; slice 68 builds the streams.

### Consequences

- Good, because the database itself refuses a half, older or shrunken release, and the history says
  why, so HZ-113's worst causes are blocked where the data lives.
- Good, because no personal data and no tenant data is involved: no DPIA change, no sub-processor.
- Good, because a phone's subset is small (a 60-bed home's MAR products, not the whole dictionary).
- Bad, because a full release is large (hundreds of thousands of packs); the loader writes in
  batches inside one long transaction, and a load must run where the worker has the memory for the
  files (slice 75 measures it against a real release).
- Bad, because a concept dm+d removes without naming a successor refuses the release until a person
  looks (H-653); that is the safe side of a rare event.
- Neutral, because the dose units offered are the unit dose unit, its form size's unit and the
  strength units; whether that is the right set is a clinical question (H-652).

### Confirmation

- `packages/domain/src/medicines/dmd-release.test.ts` and `dmd-subset.test.ts`: the checks, order,
  freshness, GTINs, search and subset, table driven (`hazard HZ-113 …`).
- `packages/db/test/dmd.test.ts`: the fixture loads and reads back; loading it again changes
  nothing; broken, older and shrunken releases refused whole with the history and the data
  unchanged; only the loader writes; published for the sync role. `rls-coverage.test.ts` lists the
  tables as national reference data; `definer-acls.test.ts` lists the loader's callers.
- `apps/api/test/dmd.test.ts` and `dmd-release-source.test.ts`: the API and the port's contract.

## Pros and cons of the options

### The NHSBSA dm+d release in global tables

- Good, because it is the national standard, complete and authoritative.
- Good, because the rules HZ-113 needs are enforced by the database.
- Bad, because Harbour must run and watch the download (slice 75).

### A third-party drug database API

- Good, because someone else loads and indexes the data.
- Bad, because every search and scan depends on a third party's uptime, offline does not work, a
  contract and a sub-processor review are needed, and Harbour cannot prove what release a screen
  showed.

### Each pharmacy supplier's product file

- Good, because it matches what that pharmacy dispenses.
- Bad, because it is not dm+d, differs per tenant, and breaks "dm+d only" (HZ-005); pharmacy feeds
  stay in Phase 5 (MEDS-010).

## More information

[integrations.md](../specs/integrations.md) section 11 (schema, rules, API, tests);
[hazard log](../clinical-safety/hazard-log.md) HZ-113; [medical-device
boundary](../compliance/medical-device-boundary.md) (dm+d reference data);
[human actions](../plans/human-actions.md) H-510, H-511 and H-650 to H-659. Revisit when slice 75
loads a real release (size, time, memory), when slice 68 measures a device's subset, and if the
NHSBSA changes the XML data model.

## Amendment (Phase 2 slice 75, 01/11/2026): the TRUD download

- **Where the load runs.** It moves out of the shared worker into a process of its own: a Cloud Run
  job (`dist/dmd-job.js`) started monthly by Cloud Scheduler. The worker unschedules its old
  `dmd-release-load` queue and keeps only a daily freshness check, so a long load never shares a
  process with the outbox and escalations.
- **What the download trusts.**
  - TRUD's answer, only when it names a dated archive on TRUD's own host, with its size and SHA-256.
  - The archive, only when it matches both.
  - Inside it, only plain XML names (and a zip nested one level), within the release's limits.
- **The key** comes from Secret Manager, into the job's environment only. It travels in the request
  path, as TRUD's API requires, and so is never put in a log line or an error.
- **Alerts** are structured log lines with log-based alert policies: `dmd.release.refused`,
  `dmd.release.failed`, `dmd.download.failed` and `dmd.release.late`. Late means older than the
  same rate-table figure the screens use. For that, `harbour_worker` reads the national rate rows
  (migration 0131).
- **No new history table.** `dmd_release` remains the history of every load; each download's
  outcome is in the job's log lines.
- **Still to do.** The Terraform for the job, its schedule and the alerts follows the Google Cloud
  integration (H-1241). TRUD's answer must be confirmed against the real service before the key
  is set (H-1242).
