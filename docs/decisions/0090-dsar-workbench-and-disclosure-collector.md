---
status: "accepted"
date: 2026-10-31
decision-makers: Thapsus engineering (Phase 2 slice 15)
consulted: data protection lead (H-612 confirms the reading)
informed: CSO; lane D (disclosure requests, slice 41)
---

# DSAR workbench and the disclosure collector

## Context and problem statement

Master prompt section 5.1 asks for a DSAR workbench (one month, extendable to three, the clock
pausing), and section 9.4 (PLAT-022) puts the DSAR and breach registers on the platform, while the
permission catalogue already holds `quality.dsar.manage` and section 11.2 lists the registers under
data security evidence. Disclosure requests (coroner, police, solicitors; slice 41, SAFE-016) need
the same "find everything about this subject" step. How do we collect a subject's records across 14
modules without each module writing its own search, and without automating decisions that the law
gives to a person (third-party redaction, exemptions)?

## Decision drivers

- One source of truth for "what tables hold personal data and how": the export catalogue already
  classifies every column of every table (`packages/domain/src/platform/export-catalogue.ts`), and a
  test fails when a table is missing.
- Third-party data and the health and social work exemptions (DPA 2018 Schedules 2 and 3) need human
  judgement; UK GDPR Art 22 and the master prompt forbid solely automated significant decisions.
- Lanes own their tables: a collector that reads the catalogue never edits another lane's files.
- Least surprise for permissions: renaming `quality.dsar.manage` would churn roles and audit history.

## Considered options

- One collector over the export catalogue with a subject map per table.
- A `collect(subject)` function in each module, called by the workbench.
- Full-text search across records (PLAT-013) for the subject's name.

## Decision outcome

Chosen option: "one collector over the export catalogue with a subject map per table", because it
covers every table that holds personal data by construction, needs no change in other lanes, and
reports tables it cannot search instead of missing them.

- `dsarSubjectMap` derives, from the catalogue, the column naming each subject kind: `person_id`
  (people), `contact_id` and the contact row (contacts), and the staff reference columns and the
  `tenant_user` row (staff). Disclosure requests (slice 41) reuse the same collector and items.
- Redaction is by a person, item by item. The item view highlights the names of the subject's
  contacts and the organisation's staff (`findThirdPartyNames`); nothing is redacted automatically.
- Erasure is assessed against retention and recorded; deletion is the retention engine's job.
  Rectification is made in the owning module and recorded on the case.
- The collector and the item view read records in the organisation's own context (no member, the
  whole organisation), as the full export does, and only after the API has required
  `quality.dsar.manage` with MFA (now a care-record permission). A case is the data protection
  lead's work across every module, so module permissions do not narrow it; the read is audited
  with the case, counts and record ids. Staff are found by their `tenant_user` row and the columns
  naming what they did (`*_by`, `*tenant_user_id`), not by `created_by` and `updated_by`, which
  every row has.
- Because the collector reads across the organisation, only an organisation-wide role may run a
  case, opening records, the bundle and the response need step-up, decisions are bound to the
  record's content hash, and the issued bundle is kept as sent (security review #149).
- The tables are platform-owned (`dsar_case`, `dsar_item`, schema file `data-rights.ts`, migration
  0077); the permission keeps its name `quality.dsar.manage`.

### Consequences

- Good, because a new table with personal data is collected as soon as it is in the catalogue.
- Good, because the reviewer sees every record and decides; the bundle shows what was redacted.
- Bad, because a record whose subject is reached only through another record (for example an
  incident answer, which names the incident, not the person) is not collected directly. Tables with
  personal data and no subject column at all are listed as "not searched" on the case, and the
  procedure asks the reviewer to follow the links from what was collected, until the map learns the
  join (H-615).
- Bad, because the item view shows care records to the DPO's role: it needs MFA and every view is
  audited as a care-record view.

### Confirmation

`packages/domain/src/platform/dsar.test.ts` (the subject map covers every catalogue table with a
subject column and reports the rest), `packages/db/test/data-rights.test.ts` (tenant isolation and
the permission), `apps/api/test/dsar.test.ts` (collection across modules, review, bundle).

## More information

[platform.md](../specs/platform.md) "Phase 2: the DSAR workbench"; [dsar-procedure.md](../compliance/dsar-procedure.md);
slice 9 rules in `packages/domain/src/platform/data-rights.ts`.
