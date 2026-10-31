# Integrations (`integrations`) - specification

Master prompt section 15.3. The integration framework (INTG-001: ports, mock adapters, contract
tests and the inbound quarantine queue) and the communications adapters (INTG-011) are specified in
[platform.md](platform.md#integrations-framework-intg-001) and [comms.md](comms.md). This file holds
the adapters Phase 2 adds ([phase-2.md](../plans/phase-2.md), lane H) and, later, the others.
**Stub**: written with the Phase 2 plan to hold the headings and the rows; each lane H slice writes
its section before its code. Status per feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Section 15.3: connect Harbour to the partners a provider already uses, each behind a domain
interface with a contract test and a mock, so a tenant without the partner still has a working
product.

| Row | Feature (register) | Phase | Plan slices |
| --- | --- | --- | --- |
| INTG-006 | dm+d dataset sync and GTIN barcode lookup | 2 | 10 (reference tables and loader), 75 (download job) |
| INTG-007 | Identity and vetting: right-to-work IDSP, DBS e-bulk and Update Service, NMC register lookup | 2 | 77 |
| INTG-013 | E-signature and OCR adapters (optional DocuSign, camera scanning with OCR for paper MARs) | 2 | 79 |
| SCHED-008 | Payroll and pension exports (Xero Payroll first, Staffology, Sage, BrightPay; auto-enrolment flags) | 2 | 76 |
| WORK-006 | SCORM and xAPI e-learning player and LMS integration (the LMS imports) | 2 | 78 |

Later phases (register): INTG-002 to INTG-005, INTG-008 and INTG-010 (Phase 5), INTG-009 (Phase 4),
INTG-012 (Phase 3); the pharmacy interface MEDS-010 (Phase 5).

## 2. Schema

To be written by each slice. Connections per tenant use `integration_connection`; credentials stay
in the secret store (section 15.3 rules). The dm+d reference tables (slice 10, migration 0110) are
in section 11.

## 3. Permissions

To be written by each slice. Choosing a provider for a tenant is a tenant setting
([platform.md](platform.md)).

## 4. Rules that are easy to get wrong

Section 15.3 rules, for every adapter:

- an adapter behind a domain interface, with a contract test and a mock;
- credentials per tenant in the secret store;
- inbound data validated against Zod schemas and quarantined on failure, with a visible queue;
- integration health on the operator console.

Section 15.3 sets the dm+d sync as monthly; section 12.3 says approved timesheets go to payroll by
API or file, with auto-enrolment flags (`auto_enrolment.earnings_trigger`).

## 5. API and events

To be written by each slice. dm+d search, product, GTIN and release history (slice 10): section 11.

## 6. Offline behaviour

The device holds the dm+d subset for its assigned people's medicines (section 17.1); scanning with
OCR happens on the phone camera (section 15.3, documents).

## 7. Clinical safety

dm+d data out of date or loaded wrongly is HZ-113; scanned or imported medicines stay "not yet
checked" until a second competent user checks them (HZ-005).

## 8. Data protection

A third-party service that receives personal data joins the
[sub-processor register](../compliance/sub-processors.md) and the DPIA (section 20 rule 8). Which
Phase 2 partners count as sub-processors is a DPO decision (H-520).

## 9. Acceptance criteria and tests

To be written by each slice: the port's contract tests pass against the mock and the real adapter.

## 10. Open questions

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0013,
[ADR-0080](../decisions/0080-dmd-reference-data.md), ADR-0094, ADR-0095, ADR-0097) and the human
actions in [human-actions.md](../plans/human-actions.md) (H-510, H-511, H-518 to H-523, H-532,
H-540; dm+d: H-650 to H-656).

## 11. dm+d reference data (INTG-006; slice 10; ADR-0080)

The NHS Dictionary of Medicines and Devices (dm+d), published by the NHSBSA through TRUD, is the
only source of the medicines Harbour records ([medicines.md](medicines.md) rule 1, HZ-005). Slice
10 builds the reference tables, the release loader, the release source port with a mock, and the
search and barcode lookups; slice 75 downloads each release from TRUD and runs the loader; slice 68
sends each device its subset. Until the TRUD account and the licence terms are in place (H-510,
H-511), development and tests use a small invented fixture (`packages/db/test/fixtures/dmd/`: two
releases of invented products, identifiers in an invented range with valid check digits and GTINs
in the GS1 restricted-circulation range 200), never real dm+d data. **Status: built (slice 10).**

### Schema (migration 0110)

`app.database_environment` (one row, owned by `harbour_owner`, readable by the loader and the
worker) says what the database is for; only `dev` and `test` accept the invented fixture (rule 1).

Global reference tables with no `tenant_id`, like `bank_holiday`: forced RLS with a read policy for
every role and one for the sync role's replication (in the `powersync` publication, ADR-0080); the
application, the worker and the sync role have SELECT only; nobody deletes or truncates (the
`dmd_never_deleted` triggers). Only the loader's SECURITY DEFINER functions write, owned by the
NOLOGIN `harbour_dmd_loader` and executable by `harbour_worker` (the job) and `harbour_owner` (a
manual run). No personal data. Each row carries the release that last added or changed it
(`release_id`), so a release that changes nothing writes nothing.

| Table | dm+d source (data model R2) | Key columns |
| --- | --- | --- |
| `dmd_release` | The release itself: the release history | `name` (the release's own name, for example `nhsbsa_dmd_10.1.0_20261026000001`), `released_on`, `source` (`nhsbsa_trud`, `fixture`, `manual`), `status` (`loading` inside the load only; `loaded`, `refused`, `failed`), `checksum` (SHA-256 of the files' names and contents), `file_counts`, `changes` (added, changed, invalidated per file; superseded; GTINs withdrawn), `problems` (the first 50) and `problem_count`, `started_at`, `finished_at`, `loaded_by` (the database role); a finished release never changes (`dmd_release_guard`) and a release still loading cannot commit (`dmd_release_committed_finished`) |
| `dmd_lookup` | `f_lookup2` `UNIT_OF_MEASURE`, `FORM`, `ROUTE`, `CONTROL_DRUG_CATEGORY`, `LEGAL_CATEGORY` | `id` (`kind:code`), `kind`, `code`, `description`, `previous_code` |
| `dmd_vtm` | `f_vtm2` `VTM` | `id` (VTMID), `name`, `abbreviated_name`, `invalid`, `previous_id`, `superseded_by` |
| `dmd_vmp` | `f_vmp2` `VMP`, `VPI` (strength units only), `DFORM`, `DROUTE`, `CONTROL_INFO` | `id` (VPID), `vtm_id`, `name`, `abbreviated_name`, `invalid`, `previous_id`, `superseded_by`, `unit_dose_uom_code`, `udfs` and `udfs_uom_code` (the unit dose form size), `strength_uom_codes` (the units of its strengths, never the ingredients), `form_code`, `route_codes`, `control_drug_category_code`, `search_name` |
| `dmd_amp` | `f_amp2` `AMP`, `LIC_ROUTE` | `id` (APID), `vmp_id`, `name`, `abbreviated_name`, `description` (with the supplier), `invalid`, `licensed_route_codes`, `search_name` (over the description) |
| `dmd_vmpp` | `f_vmpp2` `VMPP` | `id` (VPPID), `vmp_id`, `name`, `quantity`, `quantity_uom_code`, `invalid` |
| `dmd_ampp` | `f_ampp2` `AMPP` | `id` (APPID), `vmpp_id`, `amp_id`, `name`, `abbreviated_name`, `legal_category_code`, `discontinued` and `discontinued_on` (`DISCCD`, `DISCDT`), `invalid` |
| `dmd_gtin` | `f_gtin2` `AMPP`, `GTINDATA` | `id` (`ampp:gtin:start`), `ampp_id`, `gtin` (as GTIN-14), `start_date`, `end_date`, `withdrawn_release_id` |

VMP names and AMP descriptions carry a search vector (`app.search_vector`, ADR-0070) with a GIN
index. In the export catalogue every table is `not_exported` (national reference data with no
organisation rows), and `rls-coverage.test.ts` lists them as national reference tables with why.

### Permissions

| Action | Permission | Scope |
| --- | --- | --- |
| Search dm+d, look up a product or a GTIN, read the release history | Any of `medicines.record.manage`, `medicines.emar.administer`, `medicines.stock.manage` (each needs a second factor: care-record permissions) | None needed: national reference data with no personal data |
| Load a release | No API permission: the worker's job (`harbour_worker`) or a manual run by Thapsus as `harbour_owner` (`pnpm --filter @harbour/db dmd:load <release directory>`) | Global |

### Rules

1. **A release loads whole or not at all** (HZ-113). The loader (`loadDmdRelease`,
   `packages/db/src/dmd`) reads every file, checks the release (`checkDmdRelease`), and writes it in
   one transaction through `app.dmd_begin_release` (under an advisory lock), `app.dmd_load_rows`
   (each file in batches, writing a row only when it is new or changed) and
   `app.dmd_finish_release`, so readers see the previous release or the new one, never a mixture.
   What a load wrote (every identifier, and the counts) is noted in two temporary tables named after
   the release, created by `app.dmd_begin_release` and owned by `harbour_dmd_loader`, so the caller
   can neither write them nor tell `app.dmd_finish_release` what the release holds; finish works it
   out from them, and they go at commit. A refused or failed release is recorded by
   `app.dmd_record_refusal` in a transaction of its own, with its problems, and the previous release
   stays in use. A failure's message is its database code only. Each outcome is also a platform
   event in the audit chain (`medicines.dmd_release.loaded`, `.refused`, `.failed`; no tenant,
   readable by the operator).
   **Limits** (security review): before any file is read, a release with more files or bytes than
   the worker's `DMD_RELEASE_MAX_FILES` (64) or `DMD_RELEASE_MAX_BYTES` (2 GiB) allow is refused
   (`too_large`); a directory or file that is a symbolic link is refused (`lstat`, and `O_NOFOLLOW`
   when a file is opened); each file is streamed through the XML reader in 1 MiB chunks, yielding
   to the event loop between them, never read whole; and the whole load, reading and writing, stops
   after `DMD_LOAD_TIMEOUT_MINUTES` (60; each statement may run only for the time left), failing as
   `timed_out` with the release in use unchanged. The job has its own queue holding one job, queued
   or running, worked one at a time; a process of its own for the load is slice 75's.
   **The invented fixture** (security review): a release named `fixture_...` or loaded as `fixture`
   is refused (`fixture_not_allowed`), by the loader and by `app.dmd_begin_release`, unless the
   database is marked `dev` or `test` in `app.database_environment`, whatever the operator's shell
   says. The deploy's migrate task marks each environment's database from `HARBOUR_ENV`;
   `pnpm db:migrate` marks a database on this machine `dev`; test databases are marked `test`; an
   unmarked database refuses the fixture; and a database once marked anything else is never marked
   `dev` or `test` again, nor unmarked (the table's guard).
2. **Checks before loading** (`parseDmdRelease`, `checkDmdRelease`): every file present once and
   readable XML with the expected root element and no document type declaration; records in every
   file; identifiers of the SNOMED CT concept shape with a valid Verhoeff check digit (`isDmdId`),
   each once; every reference resolving (VMP to VTM, AMP to VMP, VMPP to VMP, AMPP to VMPP and AMP,
   an AMPP's AMP and VMPP naming the same VMP, GTIN to AMPP, and each VMP and AMP section to its
   product); every form, route, unit, controlled drug and legal category code in the lookups;
   quantities as decimals; GTINs of 14 digits after padding with a valid GS1 check digit; dates real,
   an end not before the start. Only the first 50 problems are kept, with the count.
3. **Never backwards, never twice, never ahead** (`dmdReleaseOrder` and `dmdReleaseDateProblem`, and
   again in `app.dmd_begin_release` under the lock): a release dated more than
   `DMD_RELEASE_FUTURE_DAYS` (3) days after today's UK date is refused (`dated_in_future`); a
   release dated before the one in use is refused (`older_than_current`); one already
   loaded under the same name is not loaded again (`already_loaded`), so a repeated run changes
   nothing. A re-issue on the same date loads.
4. **Nothing disappears.** dm+d never deletes a concept; it marks it invalid. A release missing a
   VTM, VMP, AMP, VMPP or AMPP in use is refused (`concepts_missing`, naming the first ten), unless a
   concept in it names the missing one as its previous identifier (`VTMIDPREV`, `VPIDPREV`): then
   the old row stays, pointing to its successor (`superseded_by`). A GTIN mapping absent from a new
   release is kept, withdrawn by it (`withdrawn_release_id`), and never matches a scan again unless a
   later release brings it back; the history counts it (`gtins_withdrawn`). A lookup code absent is
   kept and counted (`lookups_absent`).
5. **Out of date is said, never hidden** (`dmdReleaseFreshness`). Every search and lookup returns
   the release in use (the latest loaded by release date), its date and its status: `current`,
   `out_of_date` when it is older than `medicines.dmd.stale_after_days` (rate table, 35 days,
   Harbour default, H-651; the national row only, so a tenant cannot quieten it), or `none`, with a
   message in words. Screens show the date and, when out of date, the warning, by icon and word
   (slice 52).
6. **Search** (`dmdSearchQuery`): a dm+d code (6 digits or more) is checked with `isDmdId` and
   refused rather than matched to a near one (`invalid_code`); otherwise the words typed, each as a
   prefix (`exampl 250` finds "Examplomycin 250mg capsules"), at least 3 letters or numbers and at
   most 8 words, over VMP names and AMP descriptions in the release in use; invalid products, and
   products dm+d has given a new identifier (`superseded_by`), are left out unless asked for
   (`includeInvalid`), so a new entry is never written with a withdrawn or replaced identifier; a
   typed code shows its product whatever its state; either way they are marked. At most 25 results
   (the query bounded to 5 seconds), shortest names first, `truncated` when there were more. Ingredients are never searched or compared
   (medical-device boundary).
7. **GTIN lookup**: a scanned or typed GTIN is checked (`isGtin`) and read as GTIN-14 (`toGtin14`: a
   GTIN-8, -12 or -13 padded with zeros); an invalid check digit is refused (422 `invalid_gtin`)
   rather than looked up. It matches only mappings in force on the UK date (start on or before it,
   end on or after it) and not withdrawn; no match is 404 with the release's message. An invalid or
   discontinued pack is returned marked, after the valid ones, so the screen can say why it must
   not be used (the device subset, rule 9, leaves invalid packs out, so an offline scan never
   matches one). A GTIN on more
   than one pack returns them all, so the screen asks the person to choose (slice 22 matches the
   scan to the MAR entry, ADR-0081).
8. **Dose units and routes** (`dmdDoseUnitCodes`, `dmdProductFacts`): the units a dose of a product
   may be written in are the unit dose unit ("tablet"), the unit of its unit dose form size ("ml")
   and the units of its strengths ("mg"), each once; its routes are the VMP's routes. These feed
   `checkDose` and the route check (HZ-005). Harbour never converts between them (H-652).
9. **The device subset** (`selectDmdDeviceSubset`; slice 68 streams it): the products on the
   location's MAR entries, the products that replaced them, every valid AMP of a VMP-level entry (the
   named AMP only for an AMP-level one, kept even when invalid), their valid AMPPs and the VMPPs
   those name, the GTINs on them not withdrawn and not ended (one yet to start is kept), and the
   lookups all of those name. Products the MARs name that the data lacks are returned as
   `unresolved` for the device to say so (HZ-113).
10. **Times**: `released_on`, `start_date`, `end_date` and `discontinued_on` are dates as dm+d gives
    them; "in force" and "out of date" are judged on the UK date.

### Release source port

`DmdReleaseSourcePort` (`packages/domain/src/integrations/dmd-release-source.ts`): `latest()` gives
the latest release's name, date, source and files, or null; `health()`. Each file
(`DmdReleaseFileSource`) gives its size and its text in chunks, never whole. Adapters
(`apps/api/src/integrations/dmd.ts`): the mock serves the newest fixture release only on a
developer's machine, CI or the shared dev environment; with `NODE_ENV=production`, or `HARBOUR_ENV`
naming staging, pilot or production, there is no source (`unconfigured`) until slice 75 builds the
TRUD adapter, which must pass the same contract (`apps/api/test/dmd-release-source.test.ts`)
against a mock TRUD. The worker's `dmd-release-load` queue runs monthly (early on the 3rd) and logs
`dmd.release.loaded`, `already_loaded`, `refused`, `failed` or `none` with the release's name, date,
counts and problem codes; slice 75 alerts on them.

### API (`apps/api/src/routes/medicines-dmd.ts`)

| Route | What |
| --- | --- |
| `GET /v1/medicines/dmd/products?q=&includeInvalid=` | Search VMPs and AMPs; each result with its VMP, form, routes, controlled drug category, whether invalid and its successor |
| `GET /v1/medicines/dmd/products/{id}` | A VMP (with its AMPs and packs) or an AMP (with its VMP and packs, each with its GTINs in force), with the dose units, the unit dose form, routes and licensed routes |
| `GET /v1/medicines/dmd/gtin/{gtin}` | The packs a GTIN names today, each with its AMP and VMP and the mapping's dates |
| `GET /v1/medicines/dmd/releases` | The release history, newest first, and the release in use with its status |

Each response carries `release` (`name`, `releasedOn`, `loadedAt`, `status`, `ageDays`,
`staleAfterDays`, `message`). Reads of national reference data are not care-record views and are
not audited one by one; refusals are audited as every refusal is, and each load is recorded in
`dmd_release` (the history), which never changes once finished.

### Test list

- Domain (`packages/domain/src/medicines/dmd-release.test.ts`, `dmd-subset.test.ts`): every check in
  rule 2 from a table; release order; freshness at, before and after the limit; GTIN check digits
  and padding; the search query; dose units and routes; the device subset.
- Database, after the security review: more files or bytes than allowed and a load past its time
  limit refused with the data unchanged; symbolic links refused; chunks yielding to other work; a
  release dated ahead of today refused in the loader and the database; finish working out the
  release from what was written (the caller cannot write the notes); `pg_temp` last in each loader
  function's search path; the fixture refused in an unmarked or production-marked database under
  any source, and a production mark never turned back to `test`.
- Database (`packages/db/test/dmd.test.ts`): the fixture loads and reads back; loading it again
  changes nothing; a broken reference, unreadable XML, a missing file, a bad GTIN, a document type
  declaration, an older release and a missing concept are refused whole with the history recorded
  and the data unchanged; a newer release adds, invalidates, supersedes, discontinues and withdraws;
  the application role cannot write; no direct writes or deletes; a finished release never changes;
  a release left loading never commits; the tables are in the publication readable by the sync
  role. `rls-coverage.test.ts` and `definer-acls.test.ts` list the tables and the functions.
- API (`apps/api/test/dmd.test.ts`, `dmd-release-source.test.ts`): the job through the mock; search,
  product, GTIN and history with the release and its status; out of date said on every read and not
  quietened by a tenant's row; invalid products and mistyped codes; withdrawn and ended GTINs not
  matched; an invalid GTIN refused; members without a medicines permission refused; the port's
  contract.
