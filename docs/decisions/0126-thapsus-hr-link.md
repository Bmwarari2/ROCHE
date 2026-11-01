---
status: "accepted"
date: 2026-11-01
decision-makers: Brian (owner, asked for the link on 01/11/2026), engineering (Claude Code sessions)
consulted: data protection lead (H-1341), clinical safety officer (HZ-133)
informed: Thapsus-HR engineering
---

# Link Harbour to Thapsus-HR with one owner for each kind of staff data

## Context and problem statement

On 01/11/2026 the owner asked that a provider using both Harbour and Thapsus-HR should not have to
export shifts, rotas, time, pay or staff records between them. Thapsus-HR is the Thapsus HR
platform (repository `Bmwarari2/PROJECT_KAREN`).

The two products overlap:
- **Harbour** builds a rota, time and attendance, absence, pay rules and a payroll export in
  Phase 2 (master prompt section 12.3).
- **Thapsus-HR** already has:
  - effective-dated employee records;
  - rotas, clocking and weekly timesheets;
  - leave and sickness with SSP;
  - a payroll handoff with Xero, CSV and SFTP connectors.

If both systems could edit the same record, staff could be rostered from one version and paid from
another. How should the two systems share this data?

## Decision drivers

- **Safe staffing.** The rota a manager sees must reflect leave, sickness and leavers. A care
  shift must not change without Harbour's safe-staffing, competence and Working Time checks
  (HZ-123, HZ-124, HZ-133).
- **No double entry** and no file exports for a provider using both products.
- **Configurable, never forked.** A provider without Thapsus-HR keeps every Harbour module
  unchanged.
- **UK residency (ADR-0098).** A Thapsus-HR tenant's home region can be London, Frankfurt or Ohio.
- **Data minimisation.**
  - Only the staff data needed for rostering and pay crosses.
  - Nothing about the people who receive care goes to the HR platform.
- **Thapsus-HR's own API rules.**
  - `/v1` changes only by adding things.
  - Its payroll and compliance routes are closed to API clients today.

## Considered options

- One owner for each kind of data, chosen per tenant, with read-only copies in the other system
- Two-way sync of every record, with the newest edit winning
- Keep file exports, adding a Thapsus-HR file format to Harbour's payroll export (slice 76)
- Merge the products, so that Harbour uses Thapsus-HR as its workforce module

## Decision outcome

Chosen option: "one owner for each kind of data". It is the only option that:
- removes the exports;
- never lets two systems disagree about a shift or an absence;
- keeps each product whole for customers who use only one of them.

**Default owners.** A tenant may change an owner when it connects, and later with step-up and a
full reconciliation. A pay owner changes only from the next pay period.

| Data | Owner by default | What the other system does |
| --- | --- | --- |
| Employee core record: name, work contact details, job, location, contracted hours, start and leaving dates, employee number | Thapsus-HR | Harbour reads it. These fields are read-only in Harbour's staff file. |
| A new starter hired through Harbour's recruitment (WORK-001) | Harbour, at hire | Harbour creates the employee in Thapsus-HR, which owns the core record from then on. |
| Leavers | Thapsus-HR | Harbour ends sign-in at the end of the leaving date and starts its leaver checklist. |
| Care shifts and the rota | Harbour (safe staffing, skills, competence, Working Time, sleep-ins) | Thapsus-HR shows them read-only and compares its timesheets with them. |
| Clocking in and out at the point of care | Harbour (app and kiosk; electronic visit check-in in Phase 4) | Thapsus-HR receives the clock events. |
| Timesheet approval, and approved hours by pay code (enhancements, sleep-ins, travel time, mileage) | Harbour, using its pay rules (SCHED-005) | Thapsus-HR receives approved units for each pay period and sends them to payroll through its own connectors. |
| Pay rates and pay periods | Thapsus-HR | Harbour reads hourly rates for its minimum wage check. Thapsus-HR's pay periods become the pay reference periods. |
| Leave, sickness, SSP and fit notes | Thapsus-HR | Harbour reads dates and type only, never reasons or fit notes. It uses them to block rostering and raise cover tasks. |
| Recruitment, the Reg 19 file, DBS, right to work, sponsor duties, training, competence and supervision | Harbour (care-specific; Thapsus-HR has no DBS model or Reg 19 file) | Not sent in the first version. |

**Rules that come with the choice:**
- **One owner per record.** The other system never edits it. Harbour's reconciliation puts back
  the owner's version and records the drift.
- **UK only.** Harbour connects only to a Thapsus-HR tenant whose home region is `uk`. It checks
  this when connecting and on every sync, and otherwise refuses without sending anything.
- **No data about the people supported.** Nothing about a person who receives care goes to
  Thapsus-HR. A shift crosses as location, role, start, end and worker only, never a visit address,
  a person or a care note.
- **Calls into Thapsus-HR.** Harbour uses OAuth2 client credentials, narrowed to the tenant's
  linked locations. The secret is kept in Secret Manager.
- **Calls into Harbour.** Thapsus-HR's signed webhooks carry identifiers only. They arrive in
  Harbour's inbound quarantine queue, and Harbour then fetches the record.
- **Harbour keeps the identifier mapping.** It stores the link between its records and
  Thapsus-HR's identifiers, because Thapsus-HR has no external identifier columns.
- **Off by default.** The link sits behind the `integrations.thapsus_hr` flag.
- **Out-of-date data is said in words.** If no sync has succeeded within the tenant's staleness
  limit (default 15 minutes, H-1344), every rota and staffing screen says so. Leave known from
  the last good sync still applies.
- **No double payment.** When pay goes through Thapsus-HR, Harbour's payroll export (slice 76) is
  switched off for that tenant.
- **Thapsus-HR stays the same for its other customers.**
  - The changes it needs are generic partner features, with nothing specific to care.
  - They do nothing until a tenant connects a partner, and they only add to its API, schema and
    events.
  - Payroll outputs that stay byte-identical and an additions-only API check prove there is no
    change for every other customer ([integrations.md](../specs/integrations.md#11-thapsus-hr-link-intg-014)
    section 11.9).

### Consequences

- Good:
  - No exports.
  - One version of every shift and absence.
  - Each product still works on its own.
- Good: linked tenants don't need Harbour's payroll export. Thapsus-HR's existing payroll
  connectors deliver pay.
- Bad: Thapsus-HR needs changes before the live link works.
  - They are listed in [integrations.md](../specs/integrations.md#11-thapsus-hr-link-intg-014)
    section 11.9 as Thapsus-HR's Phase 18, and logged as H-1343.
  - Each one does nothing for a tenant that has not connected a partner.
  - Harbour builds against a contract-tested mock until then (section 20 rule 2).
- Bad: a provider that wants to edit rotas in Thapsus-HR must make Thapsus-HR the rota owner.
  - Edits made there then miss Harbour's checks at the time of editing.
  - Harbour checks every incoming shift afterwards and alerts the rota manager (HZ-123, HZ-124).

### Confirmation

- Contract tests run the Thapsus-HR port against a mock built from Thapsus-HR's published
  OpenAPI document.
- Table-driven domain tests cover:
  - ownership (Harbour refuses an edit to a field Thapsus-HR owns);
  - refusing a tenant outside the UK;
  - matching;
  - the outbound field allow-lists;
  - the staleness rule;
  - the double-payment guard.
- Hazard tests for HZ-133.
- The DPO records the link's role and purpose (H-1341).

## Pros and cons of the options

### One owner for each kind of data

- Good: no conflicting edits, and each record has an owner a person can name.
- Good: works whichever product the provider bought first.
- Bad: needs a setting per tenant and a clear "managed in Thapsus-HR" label on read-only fields.

### Two-way sync of every record

- Good: either system can edit anything.
- Bad: conflicting edits to a shift or an absence resolve silently, which is unsafe for staffing.
- Bad: Thapsus-HR keeps idempotency keys for only 24 hours and has no external identifiers, so
  loops and duplicates are likely.

### Keep file exports

- Good: Thapsus-HR doesn't change.
- Bad: the exports are what the owner asked to remove. They are manual and arrive late.

### Merge the products

- Good: one record.
- Bad: it forks Harbour for providers without Thapsus-HR, against "configurable, never forked".
- Bad: Thapsus-HR has no care-sector rules: no Reg 19 file, DBS, sleep-ins or competence.

## More information

- **Where the details live:**
  - specification: [integrations.md](../specs/integrations.md#11-thapsus-hr-link-intg-014) section 11;
  - plan: [phase-2.md](../plans/phase-2.md), slices 86 to 90;
  - register row: INTG-014;
  - human actions: H-1340 to H-1345;
  - hazard: HZ-133;
  - DPIA risk: R30.
- **Thapsus-HR facts** as of its commit d9888cef (01/11/2026):
  - API scopes are `employees`, `org`, `leave`, `time` and `documents`, each read or write;
    clients can be narrowed to locations.
  - Webhooks are signed with HMAC-SHA256, and only employee events exist.
  - `/v1/payroll` and `/v1/compliance` are closed to API clients.
  - Pay rates are in `employee_pay`.
  - The UK region is Google Cloud europe-west2 (Thapsus-HR's ADR-0214), with production not yet
    deployed.
