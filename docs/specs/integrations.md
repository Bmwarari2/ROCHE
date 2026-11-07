# Integrations (`integrations`) - specification

Master prompt section 15.3. The integration framework (INTG-001: ports, mock adapters, contract
tests and the inbound quarantine queue) and the communications adapters (INTG-011) are specified in
[platform.md](platform.md#integrations-framework-intg-001) and [comms.md](comms.md). This file holds
the adapters Phase 2 adds ([phase-2.md](../plans/phase-2.md), lane H) and, later, the others.
**Stub**: written with the Phase 2 plan to hold the headings and the rows; each lane H slice writes
its section before its code. Status per feature: [feature register](feature-register.md).

## 1. Purpose and register rows

Section 15.3: connect Thapsus Care to the partners a provider already uses, each behind a domain
interface with a contract test and a mock, so a tenant without the partner still has a working
product.

| Row | Feature (register) | Phase | Plan slices |
| --- | --- | --- | --- |
| INTG-006 | dm+d dataset sync and GTIN barcode lookup | 2 | 10 (reference tables and loader), 75 (download job) |
| INTG-007 | Identity and vetting: right-to-work IDSP, DBS e-bulk and Update Service, NMC register lookup | 2 | 77 |
| INTG-013 | E-signature and OCR adapters (optional DocuSign, camera scanning with OCR for paper MARs) | 2 | 79 |
| SCHED-008 | Payroll and pension exports (Xero Payroll first, Staffology, Sage, BrightPay; auto-enrolment flags) | 2 | 76 |
| WORK-006 | SCORM and xAPI e-learning player and LMS integration (the LMS imports) | 2 | 78 |
| INTG-014 | Thapsus-HR link: staff records, leave, rota, clocking and pay without exports | 2 | 86 to 90 |

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

The device holds the dm+d subset for its assigned people's medicines (section 17.1). Scanning a
paper MAR chart needs a connection: the phone takes the photograph and the server reads it with an
allowlisted engine in europe-west2 (ADR-0095 changes the earlier "OCR on the phone camera"); the
phone keeps nothing it read.

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

## 11. Thapsus-HR link (INTG-014)

Added at the owner's request on 01/11/2026 ([ADR-0126](../decisions/0126-thapsus-hr-link.md)).
Plan slices 86 to 90; human actions H-1340 to H-1345; hazard HZ-133; DPIA risk R30. Behind the
`integrations.thapsus_hr` flag, off by default.

### 11.1 Purpose and owners

A provider that uses both Thapsus Care and Thapsus-HR shares staff records, leave, rota, clocking and pay
without exporting files. Each kind of data has one owner per tenant, and the other system holds a
read-only copy. The default owners are set out in the table in ADR-0126 (H-1340):
- **Thapsus-HR owns:** employee records, leavers, pay rates and pay periods, leave and sickness.
- **Thapsus Care owns:**
  - care shifts and clocking;
  - timesheet approval and pay units;
  - recruitment, DBS and right to work;
  - training, competence and supervision.

A tenant without the link keeps every Thapsus Care module as it is.

### 11.2 Flows

| Flow | Direction | When | Thapsus-HR today (commit d9888cef) |
| --- | --- | --- | --- |
| Employees and their changes | Thapsus-HR to Thapsus Care | On an `employee.created`, `changed`, `transferred` or `terminated` webhook, then `GET /v1/employees/{id}`; a full reconciliation every night | Available (`employees:read`) |
| Leavers | Thapsus-HR to Thapsus Care | On `employee.terminated`, ahead of anything else in the queue | Available |
| A starter hired in Thapsus Care | Thapsus Care to Thapsus-HR | An offer accepted with a start date (WORK-001) | Available: `POST /v1/employees` (`employees:write`) |
| Locations | Mapped both ways at connection | When connecting, and when either side adds a location | Available (`org:read`) |
| Leave and sickness | Thapsus-HR to Thapsus Care | Polled by cursor every 5 minutes until events exist; nightly reconciliation | Read available (`leave:read`); events needed |
| Shifts | Thapsus Care to Thapsus-HR | Published, changed or cancelled in Thapsus Care | `/v1/shifts` available (`time:write`); a partner owner needed |
| Clock events | Thapsus Care to Thapsus-HR | Once the event has reached Thapsus Care from the device | `/v1/clock/events` available; `source` must allow a partner |
| Approved units by pay code | Thapsus Care to Thapsus-HR | Timesheet approved; pay period closed | Not available: a pay inputs route and scope needed |
| Hourly rates and pay periods | Thapsus-HR to Thapsus Care | Daily, and on `employee.changed` | Not available: a narrow pay read needed |

### 11.3 Schema (slice 87, migration 0141)

Every table has `tenant_id`, forced RLS and a policy:
- **The connection** is a row in `integration_connection` with:
  - the Thapsus-HR workspace slug and home region;
  - the API base URL, which must be `api.uk.` on Thapsus's domain;
  - the Secret Manager reference for the OAuth2 client;
  - the owners for each kind of data;
  - the staleness limit, the status, the time of the last good sync and `expected_version`.
  - Its port is `integrations.hr_link`. Thapsus's domain is this environment's configuration
    (`THAPSUS_HR_DOMAIN`), never a tenant's input: the adapter refuses a row for any other domain.
    A database check refuses a row whose home region is not `uk` or whose address is not
    `https://api.uk.` on a domain, and only holders of `integrations.hr_link.manage`, or the sync,
    write it.
- **`hr_person_link`** joins Thapsus Care's staff member to the Thapsus-HR employee identifier and
  employee number. It records how the match was made (`employee_number`, `email_and_birth_date`, `manual`,
  or `starter` for a starter Thapsus Care created), who confirmed it and when, and the earliest leaving
  date Thapsus-HR gave. Each side is unique, so nobody is linked twice. It holds identifiers only:
  no name, email or date of birth from Thapsus-HR.
- **`hr_location_link`** joins a Thapsus Care location to a Thapsus-HR location.
- **`hr_sync_state`** holds, for each kind of data, the cursor, the last good sync and the last
  error code.
- **`hr_delivery`** is the outbound delivery log. Each row holds the kind, Thapsus Care's reference,
  Thapsus-HR's identifier, the idempotency key, the state, the attempt count and the last error
  code.
- **Absences from Thapsus-HR** arrive through the scheduling absence port with source `thapsus_hr`
  and the Thapsus-HR identifier, read-only (slice 88; migration 0142 adds `absence.source` and
  `absence.hr_id`). Only the link's sync writes them, as `recorded` with no decider; a person never
  changes one. Their cover needs are raised by the sync through `app.raise_hr_cover_need`.
- **`hr_delivery.payload_sha256`** (migration 0142) is the digest of what a record last sent, so a
  changed shift goes again and an unchanged one never does.

### 11.4 Permissions

| Permission | What it allows | Built-in roles |
| --- | --- | --- |
| `integrations.hr_link.manage` | Connect and disconnect; choose owners; map locations and pay codes; rotate the client secret. Needs step-up. | owner, registered_manager, hr |
| `integrations.hr_link.review` | Confirm or reject matches; clear quarantined items | owner, registered_manager, deputy_manager, hr |
| `integrations.hr_link.read` | See sync health, staleness and drift | the roles above, and rota managers |

New permissions reach existing tenants' built-in roles through a backfill in migration 0141, which
the ratchet test checks. The rota managers holding `read` are care coordinators; deputies hold
`review` and `read`.

### 11.5 Rules that are easy to get wrong

1. **UK only.** Thapsus Care connects only when the Thapsus-HR workspace's home region is `uk` and its
   API host is the UK one. It checks both on every sync. Otherwise it refuses, sends nothing and
   alerts.
2. **One owner.** Thapsus Care refuses an edit to a field the other system owns, and shows "Managed in
   Thapsus-HR" with the time of the last sync. Reconciliation puts back the owner's version and
   records a drift event.
3. **Matching.** Match by employee number first, then by work email together with date of birth.
   Never match on name alone. Anything else goes to the review queue, and an unconfirmed person is
   neither rostered from Thapsus-HR data nor sent to it.
4. **Allow-lists for outbound fields.** Each flow sends only its listed fields (section 11.8), and
   a test fails on any other field. No service user, visit address or care note ever leaves.
5. **Idempotency.**
   - Thapsus Care's event identifier is the idempotency key.
   - Thapsus Care's record identifier is stored in Thapsus-HR as the partner reference, once it can
     hold one.
   - Thapsus-HR keeps idempotency keys for only 24 hours, so a retry older than that looks up the
     partner reference first.
6. **Rate limits.** Thapsus-HR allows 600 calls a minute per tenant by default. Thapsus Care batches
   reads, honours 429 with `Retry-After`, and backs off on errors. After repeated failures it
   alerts the rota manager and the operator console.
7. **Time.** Instants go as UTC with the Europe/London wall-clock alongside them. Shifts crossing
   midnight and clock changes follow Thapsus Care's clock-change rule (#16).
8. **Leavers fail safe.** A known leaving date ends Thapsus Care sign-in at the end of that day, even if
   later syncs fail.
9. **Staleness.**
   - Once the last good sync is older than the tenant's limit (default 15 minutes, H-1344), rota
     and safe-staffing screens say so. The notice gives the time, with an icon and words, never
     colour alone.
   - Absences already known still block rostering.
10. **Sickness detail stays in Thapsus-HR.** Only the dates and the type "sickness" cross. Reasons,
    fit notes and medical detail never do.
11. **Pay units, not money.**
    - Thapsus Care sends hours, sleep-ins, mileage and similar units by pay code, and Thapsus-HR
      applies the rates.
    - Thapsus Care reads the hourly rate only for its minimum wage check per pay reference period.
12. **No double payment.** When Thapsus-HR owns the route to payroll, Thapsus Care's payroll export
    (slice 76) is off for the tenant. Changing it takes effect from the next pay period.
13. **The rota stays with Thapsus Care.** Care shifts and the rota are a fixed Thapsus Care owner (confirmed
    06/11/2026), so every shift passes Thapsus Care's competence, required check, staffing and Working
    Time checks (HZ-123, HZ-124); Thapsus-HR shows the rota read-only.
14. **Thapsus-HR's rules stand.** For example, Thapsus-HR refuses overlapping shifts for one
    employee. Thapsus Care treats such a refusal as a delivery error for the rota manager to review. It
    is never a reason to change Thapsus-HR's behaviour for its other customers (section 11.9).

How slice 89 applies rules 11 and 12 ([ADR-0131](../decisions/0131-pay-through-thapsus-hr.md);
migration 0148; HZ-133, HZ-140). Built against the mock with Thapsus-HR's Phase 19 pay items (K4)
and pay read (K5) switched on; at the pinned commit both answer `planned`, so nothing goes live:
- **One route per pay period.** Each pay run's route is fixed when it is drafted; a correction
  takes its original's. The link's settings hold the route for periods with no run yet (Thapsus Care's
  export by default) and at most one change waiting, from the first day of a later pay period
  than any run, with a fresh step-up. A move to Thapsus-HR also needs both pay capabilities
  available, pay rates and periods owned by Thapsus-HR and timesheets by Thapsus Care, and a start on
  one of its pay periods. A run drafted with the link disconnected or off pays through Thapsus Care's
  export; a run whose route is Thapsus-HR is not locked while the link cannot take pay.
- **Pay periods and rates in.** Read once a day and on a manual sync, checked at the boundary and
  written by the sync alone (`hr_pay_period`, `hr_pay_rate`). A pay period whose dates change is
  raised, never moved. Only the employee, the hourly rate in whole pence and its effective date
  are kept; rates are read by pay holders only.
- **Pay runs.** A run for a period paid through Thapsus-HR must be one of its pay periods
  exactly. The minimum wage check uses the lowest of each member's Thapsus-HR rates in force
  during the period, and calculation is refused when rates are more than two days old; a member
  with none gets the "no role rate" exception, which cannot be overridden for such a run.
- **Units by pay code out.** Hours split as the pay line splits them (by night, weekend, bank
  holiday and overtime), sleep-ins, on-call periods away and miles; per employee and pay code,
  summed, to 2 places, from the calculation the second person checked. Before a run is locked
  every member with units must be matched and every unit kind mapped to a pay code (by a pay
  approver), or the lock is refused naming what is missing. On lock the units and their pay codes
  are kept unchanged (`hr_pay_unit`) and Thapsus Care's export is not offered. The latest locked run of
  each period (a correction carries the whole period) replaces that period's items in Thapsus-HR,
  through the delivery log; a refusal, a member no longer matched and pay left unsent on
  disconnecting go to pay approvers.

How slice 90 finishes the link (screens and guide; HZ-133, HZ-140):
- **One settings page** (`/settings/hr-link`, menu "HR platform link", shown with the flag on to
  holders of the link's permissions): status and sync health with the staleness note, check and
  sync now; connect (step-up); owners and the out-of-date limit; disconnect after a confirmation;
  location mapping; the match review queue (confirm or reject, for `.review`); what was sent; pay
  (route to payroll, a change from a later period, pay codes for pay approvers); and absence copies
  to release.
- **Held copies are listed before release**: `GET /v1/integrations/hr-link/absences/held` (manage)
  reads Thapsus-HR's list again while linked and returns the current copies it no longer lists, or
  every copy in force once disconnected; it changes nothing. The release then sends exactly those
  ids.
- **"Managed in the HR platform"** (icon and words) on absences copied from Thapsus-HR and pay runs
  paid through it (`AbsenceItem.source`, `PayRunItem.payRoute`); the API's refusal of a change says
  the same. The staff file has no web screen yet; the label and the leaving-date withdrawal come with
  it.
- **Follow-ups from slices 88 and 89**: a shift cancellation Thapsus-HR answers not found is done,
  not retried; a pay run for a period set for Thapsus-HR is not drafted while the link is down
  unless a person confirms the export (`confirmExport`, audited); pay approvers are told when the
  flag is off with locked pay unsent; a changed employee's rate is read on `employee.changed`; a rate
  Thapsus-HR stops listing for an employee is retired (only when the whole read was clean), as is a
  pay period no pay run uses.
- User guides: [registered-manager](../user-guides/registered-manager/link-to-the-hr-platform.md)
  (link, pay, releasing absence copies).

### 11.6 API and events

Thapsus Care routes (OpenAPI):
- `POST /v1/integrations/hr-link`: connect, with step-up.
- `GET /v1/integrations/hr-link`: status, owners and staleness.
- `PATCH /v1/integrations/hr-link`: owners, staleness limit, pay code mapping (`payCodes`) and
  the route to payroll from a later pay period (`payRoute`), with `expected_version`; the pay
  changes need step-up (slice 89).
- `POST /v1/integrations/hr-link/test`
- `DELETE /v1/integrations/hr-link`: stops sync and keeps the links for audit.
- `GET /v1/integrations/hr-link/matches`, `POST .../matches/{id}/confirm` and
  `POST .../matches/{id}/reject`.
- `GET /v1/integrations/hr-link/deliveries`

Slice 87 also has `POST /v1/integrations/hr-link/sync` (pull and reconcile now),
`GET /v1/integrations/hr-link/locations`, `PUT /v1/integrations/hr-link/locations/{locationId}` and
`POST /v1/integrations/hr-link/starters/{staffProfileId}` (a starter hired here, created once). The
worker reconciles every linked organisation every 5 minutes, inside the default staleness limit;
a staleness limit below 10 minutes is refused.

How slice 88 applies the rules:
- **Rule 1 first.** Before any absence comes in or any shift goes out, the workspace must still
  be in the UK on its UK address; otherwise nothing moves. One run per organisation at a time.
- **Absences in (rule 10).** Polled every 5 minutes with the rest of the sync. Only an approved
  absence of a confirmed member blocks rostering: leave, sickness and other become annual leave,
  sickness and other, dates and type only. An absence with no end date blocks until Thapsus-HR
  ends it, whatever its type. An unknown type is copied as other and raised. A change of type or
  start replaces the copy; a request, a cancellation or an absence no longer listed cancels it and
  resolves its cover needs (drift). A record that cannot be read or applied never frees a copy: it
  is raised, the run does no drift and is not a good sync. A copy already over goes at once (it
  cannot change the rota); more than 5 current copies dropping out at once are held, still
  blocking, and raised to the link's managers, who release them with a fresh step-up, a coded
  reason and the Thapsus-HR ids they reviewed: the list is read again from Thapsus-HR then, under
  the sync's lock, and any other set releases nothing (`POST /v1/integrations/hr-link/absences/release`).
  Once the link is disconnected, the same action ends the copies still in force; while it is
  connected but turned off it is refused, as Thapsus-HR may still list them. The release runs with
  the sync's rights across the organisation, as `integrations.hr_link.manage` already does. An approved absence for a member whose match is not confirmed
  is raised, never copied. A member with no home in the staff file takes the home of their oldest
  live role, else is raised. Cover needs are raised on the member's rostered shifts at any home
  (HZ-123). A person here cannot change a copy ("Managed in the HR platform").
- **Shifts and clock events out (rules 3, 4, 5, 7 and 14).** The rota publishes no per-shift event
  and time and attendance no clock event, so a delivery sweep over the delivery log sends them: on
  each sync and when a rota is published. Each assignment of a published shift at a mapped home
  goes once, again when it changes, and as a cancellation when removed or cancelled; its role is
  the member's job title (sleep-ins reach payroll as pay units, never as a shift attribute); clock
  events in and out recorded since the link was connected (a week back at most) go once each;
  breaks stay here. The idempotency key is derived from the record and what it sends, and written
  before the call, so a retry is the same request. A refusal from Thapsus-HR is raised for the rota
  manager, never retried as is. A rota publication sends the rota at once (absences wait for the
  sync).
- **Staleness (rule 9).** The older of the employee and absence syncs counts. Rota and staffing
  screens show "Staff data from the HR platform may be out of date" with the time, as an alert with
  an icon, for anyone who reads the rota (`GET /v1/integrations/hr-link/staleness`), on the rota
  builder, the staffing check, the home's rotas, absences and tasks. It has no live region (it is
  part of the page), and it still shows when the check fails or after a disconnect while copies of
  Thapsus-HR's absences remain.
- **Alerts.** Each cause is one open task for holders of `integrations.hr_link.review`, updated
  rather than raised again.
- **A wrong leaving date** is withdrawn by someone who manages the staff file, with a fresh step-up
  and a coded reason (`POST /v1/integrations/hr-link/leavers/{staffProfileId}/withdraw`), only for a
  leaving the link recorded and only when Thapsus-HR says positively that there is none: while it
  still gives the date, or cannot find the employee, it is refused and raised for review. Only
  before access has ended: once it has, the member has left, which migration 0129 makes final, so
  the withdrawal is refused (409 `hr_link_access_ended`), telling the user to ask someone who
  manages members across the organisation to reinstate them once reinstatement exists, and until
  then to invite them again. Giving access back moves to the member lifecycle rework on
  `app.change_membership` (batch 3c decision). Until it lands, Thapsus-HR can show a person active
  while Thapsus Care shows them left (HZ-133).

How slice 87 applies the rules:
- **Matching (rule 3).** Staff who have left are not candidates. Thapsus Care holds no employee number of
  its own, so automatic links are by work email with date of birth until a link records one.
  Confirming a match needs a fresh step-up and a staff file the reviewer can see; when Thapsus-HR
  already gave a leaving date, only someone who manages that staff file confirms. The queue shows
  employees with a leaving date first.
- **Leavers (rule 8).** A leaving date is written as the staff file's leaving and left-on date, only
  ever earlier; a withdrawn leaving is put back; a date that is not a real day counts as today and
  raises `integrations.hr_link.leaving_date_invalid`. Each pull and webhook ends a passed leaving at
  once; the hourly sweep is the fallback. The status says how many leavers' access could not be
  ended automatically.
- **Owners (rule 2).** While the link is connected, the staff file refuses changes to the job title
  and start date of a linked member ("Managed in Thapsus-HR"), and never moves a leaving date later
  or clears it. Reconciliation puts back the job title; a start date only when it stays on the same
  side of today, otherwise the drift is raised for review.
- **Sync health (rules 6 and 9).** Each employee is applied in its own savepoint; a failure is
  audited and raised without holding back the rest. A page cap or a repeated cursor is
  `incomplete`, never a good sync. Linked employees Thapsus-HR stops listing raise
  `integrations.hr_link.employee_missing`. Staleness is still reported after a disconnect.
- **Starters.** Only a staff file the caller can see, never their own, and not already linked; a
  repeat answers as the first delivery did.

The inbound receiver is `POST /p/integrations/thapsus-hr/{organisation id}`. It is under `/p/`, as
other routes reached with no session are, with their body cap; each organisation has its own URL
and signing secret (the connection's Secret Manager reference):
- it checks the `Thapsus-Signature` HMAC (`t=<seconds>,v1=<hex>` over `t.body`) and a 5-minute
  replay window, and drops an event identifier it has already seen;
- it is throttled per client address and per organisation before any query, and costs the same
  HMAC work whether or not the organisation has a link;
- a refusal gets one generic answer and keeps only an audit event;
- when the named employee cannot be fetched it keeps nothing and answers 503, so Thapsus-HR sends
  it again;
- payloads are validated with Zod and quarantined on failure;
- payloads carry identifiers only, so Thapsus Care fetches each record.

Outbox events consumed:
- `scheduling.shift.published`, `scheduling.shift.changed` and `scheduling.shift.cancelled`;
- `scheduling.clock_event.recorded`;
- `scheduling.timesheet.approved` and `scheduling.pay_period.closed`;
- `workforce.offer.accepted`.

Events emitted:
- `integrations.hr_link.person_linked`;
- `integrations.hr_link.sync_failed`;
- `integrations.hr_link.stale` (slice 88, with the rota's notice);
- `integrations.hr_link.drift_detected`.
- `integrations.hr_link.drift_released` (slice 88: a person released held copies, with the count and
  whether the link was connected).

Every write that the sync makes is an audit event with the actor `integration:thapsus_hr` and
opaque identifiers only.

### 11.7 Offline and clinical safety

The phone never talks to Thapsus-HR. Clock events reach Thapsus Care first through sync and are
forwarded from there. The rota on the device shows the staleness notice from its last sync.

HZ-133 is the hazard: staff data from the HR platform out of date, matched to the wrong person, or
changed outside its owner. Its controls are rules 1, 2, 3, 8, 9 and 13 above. Its tests are named
after the hazard. HZ-123 and HZ-124 gain linked-tenant tests in slice 88.

### 11.8 Data protection

**Roles.** The provider is the controller for both products. Whether Thapsus-HR is Thapsus Care's
sub-processor or the provider's own processor is H-1341.

**The new purpose (B3).** Sharing staff records, rota, clocking, absence dates and pay units with
the provider's HR platform. Lawful bases: the employment contract and legal obligations (minimum
wage, working time, SSP). For sickness dates, Article 9(2)(b). The purpose number and the DPO's
confirmation are set when slice 87 merges. DPIA risk R30 covers wrong matching, out-of-date data
and over-sharing.

Fields that cross, by flow:

| Flow | Fields |
| --- | --- |
| Employee to Thapsus Care | Thapsus-HR identifier, employee number, names, work email, work phone, date of birth (for matching only), job title, location, contracted hours, start date, leaving date |
| Starter to Thapsus-HR | Names, work email, date of birth, job title, location, contracted hours, start date |
| Absence to Thapsus Care | Thapsus-HR identifier, employee, type (leave, sickness or other), start, end, status |
| Shift to Thapsus-HR | Thapsus Care reference, employee, location, role, start, end, break minutes. Sleep-ins reach payroll as pay units, not as a shift attribute |
| Clock event to Thapsus-HR | Thapsus Care reference, employee, kind (in or out), time, location; no GPS position |
| Pay units to Thapsus-HR | Employee, pay period, pay code, units |
| Rate to Thapsus Care | Employee, hourly rate, effective from |

**Transfers.** Nothing leaves the UK. Rule 1 enforces this.

**Retention.**
- Links follow the staff file's class.
- Copies of absences follow the rotas and timesheets class.
- The delivery log is kept for 12 months.

**Notice.** The provider's staff privacy notice template gains a sentence naming the HR platform as
a recipient.

### 11.9 Changes to Thapsus-HR, without changing it for its other customers (H-1343)

Thapsus-HR may change to support the link. Most of its customers are not care providers, though,
and none of them may notice any difference. Its side is planned as its own Phase 19, "Partner
workforce link", with an ADR of its own, built and verified in its repository. This section is
the text for that phase.

**Principles**

1. **Generic, not care-specific.** Thapsus-HR gains a "partner system" capability that any
   workforce system could use:
   - shifts and clock events managed by a partner;
   - partner pay items;
   - more webhook events.

   No care-sector rule, term, screen or jurisdiction-pack value is added to Thapsus-HR. Care logic
   (sleep-ins, competence, safe staffing) stays in Thapsus Care, and sleep-ins reach payroll as pay
   items.
2. **Inert until connected.**
   - Nothing changes for a tenant until its administrator creates a partner connection.
   - The connection sits behind a per-tenant feature flag, `partnerLink`, off by default, in
     Thapsus-HR's existing registry (`packages/core/src/features.ts`).
   - A tenant without a connection has no partner rows, so none of the new code paths run.
3. **Additive only.**
   - The changes are new tables, nullable columns, widened lists of allowed values, new routes, new
     scopes and new event types.
   - No existing route, field, scope, event payload, export format or default changes meaning.
   - This stays within Thapsus-HR's own `/v1` rule (`docs/api.md`: new endpoints, optional fields
     and enum values only).
   - Its migrations stay expand-and-contract.
4. **Opt-in events.** Each Thapsus-HR webhook endpoint lists its event types
   (`webhook_endpoints.event_types`), so an existing endpoint never receives the new events unless
   its owner adds them.
5. **UK only for Thapsus Care.** Thapsus-HR refuses a Thapsus Care connection for a tenant whose home region
   is not `uk`. Its EU and US customers see no change.

**The changes**

| # | Change | Who sees a difference |
| --- | --- | --- |
| K1 | **Partner connections**: a `partner_connections` table holding the partner kind, the linked API client, the locations covered, and which of shifts, time and pay items the partner owns; administration screens to create, pause and remove a connection, with step-up | Only a tenant that creates one |
| K2 | **Partner-managed records**: nullable `partner_connection_id` and `partner_ref` on `shifts` and `clock_events`, unique per connection, with lookup by partner reference; `clock_events.source` gains `partner`. Partner-managed rows are read-only in screens and to other API clients (`409 partnerManaged`), labelled "Managed in" and the partner's name | Only rows a partner wrote, which exist only in connected tenants |
| K3 | **New events** in the catalogue and `docs/api.md`, carrying identifiers only: `shift.created`, `shift.changed` and `shift.cancelled`; `leave.approved` and `leave.cancelled`; `sickness.recorded` and `sickness.ended`, with dates only and never health data; `timesheet.approved` | Only endpoints that subscribe to them |
| K4 | **Partner pay items**: a new table and route (`PUT /v1/pay-periods/{id}/partner-items`, scope `pay-items:write`), idempotent by partner reference. A `partnerItems` section in payroll inputs and snapshots, mapped to earnings by each payroll connector's mapping. For an employee whose pay a partner owns, the hours section takes the partner's items instead of timesheets, so nobody is paid twice | Only tenants with partner items |
| K5 | **A narrow pay read**: scope `pay-rates:read`, giving the hourly rate and effective dates only, within the client's location scope, with every read audited. Pay periods become readable by API clients | Only clients granted the scope |
| K6 | **A rate-limit bucket for partners**: a partner client's calls use their own bucket, so a sync never uses up the allowance of the tenant's other API clients | Only partner clients |
| K7 | **Documentation**: Thapsus Care listed as a customer-enabled integration in `SUBPROCESSORS.md` (UK only) before any code is written, plus `docs/api.md` and the admin guide | - |

**How "no change for everyone else" is proven.** Each item below is an acceptance criterion of
Thapsus-HR's Phase 19:

- **Payroll outputs are unchanged.** For a tenant without a partner, payroll inputs, snapshots and
  every export format (CSV, Excel and Xero) are byte-identical before and after the change.
  - Golden tests on the demo tenant and the enterprise synthetic tenant prove it, including
    snapshot hashes.
  - The `partnerItems` section is left out of the canonical JSON when it is empty.
- **The API only grows.** The OpenAPI diff between `main` and the phase branch shows additions
  only, checked in `pnpm verify`.
- **Everything else still passes.** The whole existing `pnpm verify` suite passes with the feature
  deployed and no partner connected: unit, integration, contract, isolation, residency, end-to-end
  with axe, visual regression in light and dark, and Lighthouse. The only snapshot changes are for
  the new screens.
- **Existing webhooks are unchanged.** A test with a recorded endpoint shows existing endpoints
  receive exactly the events they did before.
- **Isolation and residency.**
  - The new tables join the isolation suite.
  - Residency tests cover every region pair.
  - A Thapsus Care connection is refused for EU and US tenants.
- **Performance holds.** Load-test results for the rota grid, clocking and payroll close stay
  within their current budgets.
- **Rollback is clean.** Turning the flag off or removing the connection stops all partner
  behaviour. The migrations only add things, so the previous release runs on the new schema.

Until the changes ship, Thapsus Care builds and tests against the mock. Only the flows marked available
in section 11.2 can go live.

### 11.10 Tests

- Domain, table-driven (slice 86):
  - owner checks;
  - refusal outside the UK;
  - the matching order and refusals;
  - the field allow-lists;
  - staleness at the limit and one minute past it;
  - the double-payment guard;
  - a leaving date with failed syncs.
- Contract (slices 86 to 89): the port against the Thapsus-HR mock, built from Thapsus-HR's
  OpenAPI document and re-checked when that document changes.
- Database (slice 87): cross-tenant denial for every new table, and the role backfill.
- API (slices 87 to 89):
  - webhook signature and replay;
  - quarantine;
  - reconciliation putting back the owner's version;
  - 429 handling;
  - idempotent retries after 24 hours.
- Web (slice 90): Playwright with axe on every new screen, including the staleness notice and the
  read-only labels.

## 12. dm+d reference data (INTG-006; slice 10; ADR-0080)

The NHS Dictionary of Medicines and Devices (dm+d), published by the NHSBSA through TRUD, is the
only source of the medicines Thapsus Care records ([medicines.md](medicines.md) rule 1, HZ-005). Slice
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
   or running, worked one at a time; since slice 75 the load runs as its own job ("Release download" rule 6).
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
   Thapsus Care default, H-651; the national row only, so a tenant cannot quieten it), or `none`, with a
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
   `checkDose` and the route check (HZ-005). Thapsus Care never converts between them (H-652).
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
against a mock TRUD. Slice 75 moves the monthly load out of the shared worker into its own job
("Release download" below), which logs `dmd.release.loaded`, `already_loaded`, `refused`, `failed`
or `none` with the release's name, date, counts and problem codes, and alerts on them.

### Release download (slice 75)

The TRUD adapter (`TrudDmdReleaseSource`, `apps/api/src/integrations/trud.ts`) implements the
release source port; the rules it follows are pure functions in
`packages/domain/src/integrations/trud.ts`. **Status: built against a mock TRUD; not yet run against
the real service (H-1240 to H-1243).**

1. **Discovery.** `GET {TRUD_BASE_URL}/keys/{key}/items/{TRUD_DMD_ITEM}/releases?latest` (item 24,
   the NHSBSA dm+d release). The answer is accepted only when it names one release with an archive
   file name of the form `<release name>.zip` whose release name carries its date
   (`nhsbsa_dmd_10.1.0_20261026000001.zip`), an `https` archive address on an allowed host
   (`TRUD_ALLOWED_HOSTS`, `isd.digital.nhs.uk` by default), a size above zero and within
   `DMD_ARCHIVE_MAX_BYTES`, and a SHA-256 of 64 hexadecimal characters; anything else is refused as
   `trud_response_invalid`, and nothing is downloaded (`checkTrudRelease`).
2. **Not twice.** A release already loaded under that name is not downloaded again
   (`already_loaded`). A refused release is downloaded and checked again at the next run, so a
   corrected parser can load it.
3. **Download.** Over HTTPS only. The archive address and every redirect (at most three) must be
   on an allowed host (`trudUrlAllowed`), so a changed answer cannot point the job elsewhere. The
   archive streams into a private directory (mode 0700) and stops as soon as it passes the size it
   declared or the limit (`DMD_ARCHIVE_MAX_BYTES`, 256 MiB). Its SHA-256 must equal the one
   declared (`checksum_mismatch` otherwise). It is checked as it streams, then again through the
   same open file the archive is unpacked from, so nothing can swap it in between. On any failure,
   or when the job is stopped (SIGTERM), the files are deleted and nothing is loaded. The whole run
   has one deadline (`DMD_LOAD_TIMEOUT_MINUTES`), and TRUD's answer has 30 seconds within it. The
   SHA-256 comes from the same answer as the address: it proves the archive arrived whole, not that
   TRUD's answer is genuine, because TRUD publishes no independent signature (HZ-113 residual risk).
4. **Unpacking.** At most `DMD_RELEASE_MAX_FILES` files are kept, and at most four times as many
   entries are read, skipped ones included (`archive_too_large`). Each entry's name must be a plain
   file name (`dmdArchiveEntryName`), and its type a regular file: an encrypted entry, a symbolic
   link or a device is refused (`archive_unsafe`). An absolute path, `..`, a backslash, a nested folder
   other than the release's own, or a duplicate name is refused (`archive_unsafe`). Only `.xml`
   files are kept, plus `.zip` files nested one level deep and unpacked under the same rules (the
   GTIN file may come nested; H-654). Bytes are counted as they inflate, and the whole release is
   held to `DMD_RELEASE_MAX_BYTES` (`archive_too_large`), so a small archive cannot fill the disk.
   The directory is then read as a manual run reads one (`readDmdReleaseDirectory`: no symbolic
   links, regular files only, the same limits) and loaded through the release loader (rules 1 to 4).
5. **Credentials.** The TRUD API key (`TRUD_API_KEY`) comes from Secret Manager, as the job's
   environment (H-510, H-1240). It appears only in the request path. It is never in a log line, an
   error message, the release history or an audit event: errors carry a code and an HTTP status
   only (`TrudError`).
6. **Its own process and role.** The download and load run as a Cloud Run job, `node
   dist/dmd-job.js` (`apps/api/src/jobs/dmd-job.ts`), not in the shared worker. It connects as its
   own database role, `harbour_dmd_job` (`DATABASE_DMD_URL`, migration 0131). That role may call
   the loader's functions and read the dm+d tables, and nothing else: no organisation's rows, no
   outbox, no notifications, so a flaw in parsing an archive from the internet reaches nothing else.
   The worker may no longer call the loader. Where real people work the job refuses to start on the
   local default address. Cloud Scheduler starts it monthly,
   early on the 3rd, with one execution at a time, and it exits non-zero when a release is refused,
   fails or cannot be downloaded. The job's Terraform waits for the Google Cloud integration (H-1241).
   `pnpm --filter @harbour/api dmd:run` runs it once on a developer's machine, against the mock.
   The shared worker no longer loads dm+d; it keeps the daily freshness check (rule 7).
7. **Alerts** (HZ-113). Each line carries the release's name and date and the problem codes, never
   the key. Each event has a log-based alert to the operator (H-1241):
   - `dmd.release.refused` and `dmd.release.failed`, from the loader;
   - `dmd.download.failed`, with the code: `trud_unreachable`, `trud_refused` (an HTTP status such
     as 401 for a lapsed key), `trud_response_invalid`, `checksum_mismatch`, `archive_unsafe`,
     `archive_too_large`, `download_too_large`, or `trud_unconfigured` (no key where real people
     work, which also fails the job rather than passing quietly);
   - `dmd.release.late`, from the worker's daily check, once the release in use is older than
     `medicines.dmd.stale_after_days` (35 days, the same figure every screen uses), or when no
     release is loaded where real people work.
8. **Where it runs.** The fixture environments are listed, never the real ones
   (`realPeopleEnvironment`): a developer's machine (`HARBOUR_ENV` unset), `local`, `ci`, `dev` and
   `test` keep the mock and never call TRUD. Any other name, or `NODE_ENV=production`, counts as an
   environment where real people work. There the TRUD adapter is used when `TRUD_API_KEY` is set, and
   otherwise there is no source and the job fails (`trud_unconfigured`). A new environment's name
   therefore fails safe. The invented fixture stays refused outside dev and test databases (rule 1).
   The deployed job always runs with `NODE_ENV=production` (H-1505), so in every Google Cloud
   environment it downloads from TRUD or fails; dev has no TRUD key, so the job is not scheduled
   there and has no dm+d alerts. In production mode its settings are checked on their own
   (`loadDmdJobConfig`): `DATABASE_DMD_URL` connects as `harbour_dmd_job` to the database's private
   IPv4 address (10/8, 172.16/12 or 192.168/16) with `sslmode` `verify-ca` or `verify-full`, and
   carries no query settings but `sslmode` and `sslrootcert`, each once (pg reads every one), and `TRUD_ALLOWED_HOSTS` lists only
   TRUD's own host.

**Schema** (migration 0131):
- the login role `harbour_dmd_job` (created by `db:bootstrap`) receives EXECUTE on the four loader
  functions, granted by their owner `harbour_dmd_loader`, and SELECT on the dm+d tables and
  `app.database_environment`;
- `harbour_worker` loses EXECUTE on the loader;
- `harbour_worker` may read the national rows of `rate_table` (a restrictive policy keeps it to
  `tenant_id IS NULL`), so the daily check reads the same figure as the screens. No new table: each download's outcome is in the job's log lines, and each load is in
`dmd_release`.

**Test list (slice 75)**:
- Domain (`packages/domain/src/integrations/trud.test.ts`), table-driven: the TRUD answer accepted
  or refused field by field; allowed and refused addresses; entry names accepted and refused.
- API (`apps/api/test/dmd-trud.test.ts`), against a mock TRUD on 127.0.0.1:
  - the port's contract, and a release loaded end to end;
  - already loaded, so not downloaded again;
  - a checksum mismatch, an oversized download and a redirect off the allowed hosts refused;
  - path traversal, too many entries, a zip bomb and a nested zip;
  - a 401 reported without the key;
  - the job's exit status and log events;
  - the late check at, before and after 35 days.
- Database (`packages/db/test/dmd.test.ts`): the worker reads the national rate rows and no
  organisation's.

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
The decisions and defaults are in [phase-2.md](../plans/phase-2.md) (ADR-0013, ADR-0080, ADR-0094,
ADR-0095, ADR-0097) and the human actions in [human-actions.md](../plans/human-actions.md) (H-510,
H-511, H-518 to H-523, H-532, H-540).

## 11. E-signature and OCR adapters (slice 79, INTG-013, ADR-0095)

Two ports, each with a mock and a contract test (`apps/api/src/integrations/esign-ocr.test.ts`).
Domain rules: `packages/domain/src/integrations/esign-ocr.ts`. Schema: migration 0133
(`packages/db/src/schema/esign-ocr.ts`). API: `apps/api/src/routes/esign-ocr.ts`.

### 11.1 E-signature (`documents.signature`)

1. A member with `platform.document.manage` asks a named, active member to sign the **current
   version** of an **organisation document** (category `organisation_document`; its SHA-256 must
   match). A staff HR document, a logo and a person's document are refused (not found).
   A person receiving care, or their representative, signs with the existing typed-name flow and a
   recorded capacity.
2. **In Thapsus Care** (provider `in_app`, every organisation's default): only the member named signs,
   only while the request is open, only the exact bytes asked for (the hash they read must match
   the request and the current version), and only with a second factor used within the step-up
   window (ADR-0072). The typed-name `document_signature` row and the request's evidence (the
   signature, the time, that step-up was met) are written in one transaction. Someone else's
   request answers "not found".
3. **DocuSign** (provider `docusign`) only when the organisation chose it in
   `integration_connection` (port `documents.signature`) and the adapter is on (`DOCUSIGN`; today a
   no-network mock, refused in production until H-540). The envelope carries the document, its
   hash, a generic subject ("A document to sign") and the signer's name and the email they sign
   in with, nothing else. A send that fails or throws marks the request failed. Refreshing a request asks the provider where it stands: declined and voided close it; a
   completed envelope's signed copy is stored as a **new version** of the document through the
   storage port (malware scan first: an infected copy is never stored; the original's retention
   class), stored once however often it is refreshed, and only a copy that scanned clean marks the
   request signed (`envelopeTransition`). Cancelling checks the version first, then voids the
   envelope with a fixed reason, never the member's words.
4. A finished request (signed, declined, cancelled, failed) never changes, and its document, hash,
   signer and provider never change (database trigger).

### 11.2 OCR of scanned MAR charts (`documents.ocr`)

5. **Engines**: `OCR_ENGINES` lists those allowed and the only location each may run in:
   `google_document_ai` in `europe-west2` (Document AI, under the Google Cloud sub-processor entry,
   ADR-0098; the adapter waits for H-1262) and `mock` locally. Configuration refuses any other, the
   database refuses an extraction naming any other (`ocr_extraction_engine`), and production
   refuses the mock. With none configured, scanning answers "switched off".
6. OCR is switched on per organisation: `integration_connection` with port `documents.ocr` and
   the configured engine as provider, after the organisation's DPIA covers it (H-548, H-1261);
   otherwise scanning answers "switched off". `OCR_ENGINE` is `none` unless set; the mock reads
   nothing from an image without test instructions.
7. A member with `medicines.record.manage` that reaches the person uploads the photograph (capped
   before it is read, like every upload), optionally with an `Idempotency-Key` (a UUID): a retry
   with the same key returns the first scan. It is stored first as the person's document
   (`person_document`: malware scan, care record retention); an image that does not scan clean is
   never read. The allowlist is checked again just before the engine is called. A result with a
   line outside 0 to 199 or a part Thapsus Care does not know is refused whole (`unreadable`), never
   coerced.
8. Every value read is **unconfirmed**. A person confirms it as read, corrects it, or rejects it;
   confirming or correcting also decides **which chart line and which part** it is (the engine's
   are a proposal; `decidedLine`, `decidedLabel`). A text longer than a value holds is cut and
   marked truncated: corrected or rejected, never confirmed. A person can add a value the scan
   missed (`addedByPerson`). The engine's confidence is never sent to the screen: only a "check
   carefully" flag below `OCR_LOW_CONFIDENCE`. A decided value and the text as read never change.
9. **Release** (`releaseRefusal`) needs: every value decided; no part standing twice on one line
   (never joined); no line's values without its medicine (never dropped); at least one medicine
   line; the person's own count of medicine lines on the paper chart (typed, never prefilled)
   matching; every medicine line marked `active` or `stopped` on the chart (`cannot_tell` blocks
   release until the prescriber or pharmacy is asked); the name and date of birth on the chart
   confirmed as the person's (HZ-130); the chart's period, and that it is the chart in use now.
   It emits `integrations.ocr_mar_released` with ids and a line count only.
10. The medicines module (slice 51) reads `GET /v1/ocr-extractions/{id}/medicine-lines`: lines in
    force only, each part with how it was decided (confirmed, corrected, added by a person) or
    null; notes kept with their line and chart notes kept apart; stopped lines listed by number;
    the photograph's id; who decided values and who released, none of whom may be the second
    checker (slice 51). Each line is origin `import`, **not yet checked**, and **held** ("do not
    give") until its second check whatever the organisation's usual rule (`marEntryStatus`;
    HZ-005, H-548). OCR never writes a MAR entry and never chooses a dm+d product, a dose unit or
    a schedule.
11. A scan can be discarded instead; nothing it read is then used. The image stays the person's
    document.
12. Screen rules for the later web and mobile slices (H-1266; HZ-005 controls): the photograph
    beside every value; no bulk confirm; the correction box never prefilled; the engine's number
    never shown; a released scan shown as "Released: waiting to be added to the MAR" until slice
    51 has transcribed it.

### 11.3 Permissions

No new permissions (so no role backfill): `platform.document.manage` asks for, cancels and
refreshes signature requests; any member signs requests naming them (step-up);
`integrations.connection.manage` chooses the provider; `medicines.record.manage`, where it reaches
the person, scans, decides, releases and reads lines.

### 11.4 API

| Route | Purpose |
| --- | --- |
| `POST /v1/documents/{id}/signature-requests` | Ask a member to sign (sends the envelope through DocuSign when chosen) |
| `GET /v1/documents/{id}/signature-requests` | A document's requests |
| `GET /v1/me/signature-requests` | What I am asked to sign |
| `POST /v1/signature-requests/{id}/sign` | Sign in Thapsus Care (step-up) |
| `POST /v1/signature-requests/{id}/cancel` | Cancel with a reason |
| `POST /v1/signature-requests/{id}/refresh` | Ask DocuSign where it stands; store a clean signed copy |
| `POST /v1/people/{id}/mar-scans` | Scan a paper MAR chart (the body is the photograph) |
| `GET /v1/people/{id}/ocr-extractions` | A person's scans |
| `GET /v1/ocr-extractions/{id}` | A scan with each value (view audited) |
| `POST /v1/ocr-extractions/{id}/fields/{fieldId}/decision` | Confirm, correct or reject a value, deciding its line and part |
| `POST /v1/ocr-extractions/{id}/fields` | Add a value the scan missed |
| `POST /v1/ocr-extractions/{id}/release` | Release a fully accounted-for scan (count, line statuses, person, period) |
| `POST /v1/ocr-extractions/{id}/discard` | Discard a scan |
| `GET /v1/ocr-extractions/{id}/medicine-lines` | A released scan's lines, for slice 51 |

Audit events: `platform.signature.requested`, `.sent`, `.failed`, `.signed`, `.cancelled`,
`.refreshed`; `integrations.ocr.blocked`, `.read`, `.viewed`, `.decided`, `.added`, `.released`,
`.discarded`, `.lines_read`. None carries a value read or typed.

### 11.5 Data protection and retention

Signature requests: who is asked to sign which organisation document, and how it was signed;
retained with the document (`as_subject`). OCR extractions and fields: health data about the
person, in the person's scope (history included), retained as the care record. Records of
processing, data standards, retention, the sub-processor register and the DPIA (R25) are updated
with this slice.

### 11.6 Tests

Domain (`esign-ocr.test.ts`), adapter contracts (`apps/api/src/integrations/esign-ocr.test.ts`),
database (`packages/db/test/esign-ocr.test.ts`) and API (`apps/api/test/esign-ocr.test.ts`).
Web and mobile screens for scanning and signing are later slices (H-1266).
