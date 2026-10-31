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
in the secret store (section 15.3 rules).

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

To be written by each slice.

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

The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0013, ADR-0080, ADR-0094,
ADR-0095, ADR-0097) and the human actions in [human-actions.md](../plans/human-actions.md) (H-510,
H-511, H-518 to H-523, H-532, H-540).

## 11. dm+d reference data (INTG-006; slice 10; ADR-0080)

The NHS Dictionary of Medicines and Devices (dm+d), published by the NHSBSA through TRUD, is the
only source of the medicines Harbour records ([medicines.md](medicines.md) rule 1, HZ-005). Slice
10 builds the reference tables, the release loader and the search and barcode lookups; slice 75
downloads each release from TRUD and runs the loader; slice 68 sends each device its subset. Until
the TRUD account and the licence terms are in place (H-510, H-511), development and tests use a
small invented fixture (`packages/db/fixtures/dmd/`: invented products, codes in an invented
namespace and GTINs in the GS1 internal range 200), never real dm+d data.

### Schema (migration 0072)

Global reference tables with no `tenant_id`, like `bank_holiday`: every role reads them; only the
loader writes them (`harbour_worker` for the slice 75 job, `harbour_owner` for a manual run and
the seed); the application role has SELECT only. No personal data. Each row carries the release
it was last loaded from (`release_id`).

| Table | dm+d source (data model R2) | Key columns |
| --- | --- | --- |
| `dmd_release` | The release itself: the release history | `name` (the release's own name, for example `nhsbsa_dmd_10.1.0_20261026000001`), `released_on`, `source` (`nhsbsa_trud`, `fixture`, `manual`), `status` (`loading`, `loaded`, `refused`, `failed`), the SHA-256 checksum of the files, the counts per file, the problems found, started and finished, `loaded_by` (the database role); a finished release never changes |
| `dmd_lookup` | `f_lookup2`: `UNIT_OF_MEASURE`, `FORM`, `ROUTE`, `CONTROL_DRUG_CATEGORY` | `kind`, `code`, `description`, `previous_code` |
| `dmd_vtm` | `f_vtm2` `VTM` | `id` (VTMID), `name`, `abbreviated_name`, `invalid`, `previous_id` |
| `dmd_vmp` | `f_vmp2` `VMP`, `DFORM`, `DROUTE`, `CONTROL_INFO` | `id` (VPID), `vtm_id`, `name`, `abbreviated_name`, `invalid`, `previous_id`, `unit_dose_uom_code`, `udfs` and `udfs_uom_code` (the unit dose form size), `form_code`, `route_codes`, `control_drug_category_code` |
| `dmd_amp` | `f_amp2` `AMP`, `LIC_ROUTE` | `id` (APID), `vmp_id`, `name`, `abbreviated_name`, `description` (with the supplier), `invalid`, `licensed_route_codes` |
| `dmd_vmpp` | `f_vmpp2` `VMPP` | `id` (VPPID), `vmp_id`, `name`, `quantity`, `quantity_uom_code`, `invalid` |
| `dmd_ampp` | `f_ampp2` `AMPP` | `id` (APPID), `vmpp_id`, `amp_id`, `name`, `abbreviated_name`, `legal_category_code`, `discontinued_code`, `invalid` |
| `dmd_gtin` | `f_gtin2` `AMPP`, `GTINDATA` | `ampp_id`, `gtin` (as GTIN-14), `start_date`, `end_date` |

Each table has a text `id` (the dm+d identifier; `kind:code` for a lookup; `ampp:gtin:start` for a
GTIN mapping) so a sync stream can use it, and the tables are in the PowerSync publication with
SELECT for the sync role (ADR-0080). VMP and AMP names carry a search vector (`app.search_vector`,
ADR-0070).

### Permissions

| Action | Permission | Scope |
| --- | --- | --- |
| Search dm+d, look up a product or a GTIN, read the release history | Any of `medicines.record.manage`, `medicines.emar.administer`, `medicines.stock.manage` | None needed: national reference data with no personal data |
| Load a release | No API permission: the slice 75 job (`harbour_worker`) or a manual run by Thapsus (`pnpm --filter @harbour/db dmd:load`) | Global |

### Rules

1. **A release loads whole or not at all** (HZ-113). The loader reads every file, checks the
   release (`checkDmdRelease`), and writes it in one transaction under an advisory lock, so
   readers see the previous release or the new one, never a mixture. A refused or failed release
   is recorded in the history with its problems, and the previous release stays in use.
2. **Checks before loading** (`checkDmdRelease`): every file present and readable XML, with
   records; identifiers of the SNOMED CT concept shape (6 to 18 digits, partition `00` or `10`),
   each once; every reference resolving (VMP to VTM, AMP to VMP, VMPP to VMP, AMPP to VMPP and AMP,
   an AMPP's AMP and VMPP naming the same VMP, GTIN to AMPP); every form, route, unit and
   controlled drug category code in the lookups; GTINs of 8, 12, 13 or 14 digits with a valid GS1
   check digit, an end date not before the start.
3. **Never backwards, never twice** (`dmdReleaseOrder`): a release dated before the one in use is
   refused; one already loaded under the same name is not loaded again.
4. **Nothing disappears.** dm+d never deletes a concept; it marks it invalid. A release missing a
   VTM, VMP, AMP, VMPP or AMPP the current one has is refused (`concepts_missing`). A GTIN mapping
   absent from a new release is kept but no longer matches a scan, and is counted in the history
   (`gtins_withdrawn`).
5. **Out of date is said, never hidden** (`dmdReleaseFreshness`). Every search and lookup returns
   the release in use, its date and its status: `current`, `out_of_date` when it is older than
   `dmd.release.stale_after_days` (rate table, Harbour default, to verify, H-651), or `none`.
   Screens show the date and, when out of date, the warning, by icon and word.
6. **Search** (`dmdSearchQuery`): the words typed, each as a prefix (`par 500` finds "Paracetamol
   500mg tablets"), over VMP and AMP names in the release in use; invalid products are left out
   unless asked for, and then marked; at most 25 results, shortest names first. Ingredients are
   never searched or compared (medical-device boundary).
7. **GTIN lookup**: a scanned or typed GTIN is checked (`isGtin`) and read as GTIN-14 (a GTIN-13 or
   GTIN-12 is padded with zeros); it matches only mappings in force on the UK date and present in
   the release in use. An invalid check digit is refused (422) rather than looked up; no match is
   404. A GTIN that maps to more than one pack returns them all, so the screen asks the person to
   choose (slice 22 matches the scan to the MAR entry).
8. **Times**: `released_on`, `start_date` and `end_date` are dates as dm+d gives them; "in force"
   is judged on the UK date.

### API (`apps/api/src/routes/medicines-dmd.ts`)

| Route | What |
| --- | --- |
| `GET /v1/dmd/products?q=&includeInvalid=` | Search VMPs and AMPs; each result with its VMP, form, routes, controlled drug category and whether invalid |
| `GET /v1/dmd/products/{id}` | A VMP (with its AMPs and packs) or an AMP (with its VMP and packs) |
| `GET /v1/dmd/gtin/{gtin}` | The packs a GTIN maps to today, each with its AMP and VMP |
| `GET /v1/dmd/releases` | The release history, newest first, and the release in use with its status |

Each response carries `release` (`name`, `releasedOn`, `loadedAt`, `status`, `message`). Reads of
national reference data are not care-record views and are not audited one by one; each load is
recorded in `dmd_release` (the history), which is never changed once finished.

### Test list

- Domain (`packages/domain/src/medicines/dmd-release.test.ts`): every check in rule 2 from a
  table; release order; freshness at, before and after the limit; GTIN check digits and
  normalisation; the search query.
- Database (`packages/db/test/dmd.test.ts`): the fixture loads and reads back; loading it again
  changes nothing; a broken reference, a missing concept, unreadable XML and an older release are
  refused whole with the history recorded and the previous data unchanged; a newer release adds
  and invalidates; the application role cannot write; the tables are global, forced RLS and in
  the publication readable by the sync role.
- API (`apps/api/test/dmd.test.ts`): search, product, GTIN and history with the release and its
  status; out of date said; an invalid GTIN refused; withdrawn and ended GTINs not matched;
  members without a medicines permission refused.
