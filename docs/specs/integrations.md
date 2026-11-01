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
| INTG-014 | Thapsus-HR link: staff records, leave, rota, clocking and pay without exports | 2 | 86 to 90 |

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

## 11. Thapsus-HR link (INTG-014)

Added at the owner's request on 01/11/2026 ([ADR-0126](../decisions/0126-thapsus-hr-link.md)).
Plan slices 86 to 90; human actions H-1340 to H-1345; hazard HZ-133; DPIA risk R30. Behind the
`integrations.thapsus_hr` flag, off by default.

### 11.1 Purpose and owners

A provider that uses both Harbour and Thapsus-HR shares staff records, leave, rota, clocking and pay
without exporting files. Each kind of data has one owner per tenant, and the other system holds a
read-only copy. The default owners are set out in the table in ADR-0126 (H-1340):
- **Thapsus-HR owns:** employee records, leavers, pay rates and pay periods, leave and sickness.
- **Harbour owns:**
  - care shifts and clocking;
  - timesheet approval and pay units;
  - recruitment, DBS and right to work;
  - training, competence and supervision.

A tenant without the link keeps every Harbour module as it is.

### 11.2 Flows

| Flow | Direction | When | Thapsus-HR today (commit d9888cef) |
| --- | --- | --- | --- |
| Employees and their changes | Thapsus-HR to Harbour | On an `employee.created`, `changed`, `transferred` or `terminated` webhook, then `GET /v1/employees/{id}`; a full reconciliation every night | Available (`employees:read`) |
| Leavers | Thapsus-HR to Harbour | On `employee.terminated`, ahead of anything else in the queue | Available |
| A starter hired in Harbour | Harbour to Thapsus-HR | An offer accepted with a start date (WORK-001) | Available: `POST /v1/employees` (`employees:write`) |
| Locations | Mapped both ways at connection | When connecting, and when either side adds a location | Available (`org:read`) |
| Leave and sickness | Thapsus-HR to Harbour | Polled by cursor every 5 minutes until events exist; nightly reconciliation | Read available (`leave:read`); events needed |
| Shifts | Harbour to Thapsus-HR | Published, changed or cancelled in Harbour | `/v1/shifts` available (`time:write`); a partner owner needed |
| Clock events | Harbour to Thapsus-HR | Once the event has reached Harbour from the device | `/v1/clock/events` available; `source` must allow a partner |
| Approved units by pay code | Harbour to Thapsus-HR | Timesheet approved; pay period closed | Not available: a pay inputs route and scope needed |
| Hourly rates and pay periods | Thapsus-HR to Harbour | Daily, and on `employee.changed` | Not available: a narrow pay read needed |

### 11.3 Schema (slice 87, migration 0139)

Every table has `tenant_id`, forced RLS and a policy:
- **The connection** is a row in `integration_connection` with:
  - the Thapsus-HR workspace slug and home region;
  - the API base URL, which must be `api.uk.` on Thapsus's domain;
  - the Secret Manager reference for the OAuth2 client;
  - the owners for each kind of data;
  - the staleness limit, the status, the time of the last good sync and `expected_version`.
- **`hr_person_link`** joins Harbour's staff member to the Thapsus-HR employee identifier and
  employee number. It records how the match was made (`employee_number`, `email_and_birth_date` or
  `manual`), who confirmed it and when. Each side is unique, so nobody is linked twice.
- **`hr_location_link`** joins a Harbour location to a Thapsus-HR location.
- **`hr_sync_state`** holds, for each kind of data, the cursor, the last good sync and the last
  error code.
- **`hr_delivery`** is the outbound delivery log. Each row holds the kind, Harbour's reference,
  Thapsus-HR's identifier, the idempotency key, the state, the attempt count and the last error
  code.
- **Absences from Thapsus-HR** arrive through the scheduling absence port with source `thapsus_hr`
  and the Thapsus-HR identifier, read-only (slice 88). Lane H never writes lane C's tables.

### 11.4 Permissions

| Permission | What it allows | Built-in roles |
| --- | --- | --- |
| `integrations.hr_link.manage` | Connect and disconnect; choose owners; map locations and pay codes; rotate the client secret. Needs step-up. | owner, registered_manager, hr |
| `integrations.hr_link.review` | Confirm or reject matches; clear quarantined items | owner, registered_manager, deputy_manager, hr |
| `integrations.hr_link.read` | See sync health, staleness and drift | the roles above, and rota managers |

New permissions reach existing tenants' built-in roles through a backfill in migration 0139, which
the ratchet test checks.

### 11.5 Rules that are easy to get wrong

1. **UK only.** Harbour connects only when the Thapsus-HR workspace's home region is `uk` and its
   API host is the UK one. It checks both on every sync. Otherwise it refuses, sends nothing and
   alerts.
2. **One owner.** Harbour refuses an edit to a field the other system owns, and shows "Managed in
   Thapsus-HR" with the time of the last sync. Reconciliation puts back the owner's version and
   records a drift event.
3. **Matching.** Match by employee number first, then by work email together with date of birth.
   Never match on name alone. Anything else goes to the review queue, and an unconfirmed person is
   neither rostered from Thapsus-HR data nor sent to it.
4. **Allow-lists for outbound fields.** Each flow sends only its listed fields (section 11.8), and
   a test fails on any other field. No service user, visit address or care note ever leaves.
5. **Idempotency.**
   - Harbour's event identifier is the idempotency key.
   - Harbour's record identifier is stored in Thapsus-HR as the partner reference, once it can
     hold one.
   - Thapsus-HR keeps idempotency keys for only 24 hours, so a retry older than that looks up the
     partner reference first.
6. **Rate limits.** Thapsus-HR allows 600 calls a minute per tenant by default. Harbour batches
   reads, honours 429 with `Retry-After`, and backs off on errors. After repeated failures it
   alerts the rota manager and the operator console.
7. **Time.** Instants go as UTC with the Europe/London wall-clock alongside them. Shifts crossing
   midnight and clock changes follow Harbour's clock-change rule (#16).
8. **Leavers fail safe.** A known leaving date ends Harbour sign-in at the end of that day, even if
   later syncs fail.
9. **Staleness.**
   - Once the last good sync is older than the tenant's limit (default 15 minutes, H-1344), rota
     and safe-staffing screens say so. The notice gives the time, with an icon and words, never
     colour alone.
   - Absences already known still block rostering.
10. **Sickness detail stays in Thapsus-HR.** Only the dates and the type "sickness" cross. Reasons,
    fit notes and medical detail never do.
11. **Pay units, not money.**
    - Harbour sends hours, sleep-ins, mileage and similar units by pay code, and Thapsus-HR
      applies the rates.
    - Harbour reads the hourly rate only for its minimum wage check per pay reference period.
12. **No double payment.** When Thapsus-HR owns the route to payroll, Harbour's payroll export
    (slice 76) is off for the tenant. Changing it takes effect from the next pay period.
13. **Thapsus-HR as rota owner.** If a tenant makes Thapsus-HR the rota owner, Harbour checks every
    incoming shift against competence, required checks and the tenant's staffing need, and alerts
    the rota manager (HZ-123, HZ-124).

### 11.6 API and events

Harbour routes (OpenAPI):
- `POST /v1/integrations/hr-link`: connect, with step-up.
- `GET /v1/integrations/hr-link`: status, owners and staleness.
- `PATCH /v1/integrations/hr-link`: owners, staleness limit and pay code mapping, with
  `expected_version` and step-up.
- `POST /v1/integrations/hr-link/test`
- `DELETE /v1/integrations/hr-link`: stops sync and keeps the links for audit.
- `GET /v1/integrations/hr-link/matches`, `POST .../matches/{id}/confirm` and
  `POST .../matches/{id}/reject`.
- `GET /v1/integrations/hr-link/deliveries`

The inbound receiver is `POST /v1/integrations/inbound/thapsus-hr`:
- it checks the `Thapsus-Signature` HMAC and a replay window;
- payloads are validated with Zod and quarantined on failure;
- payloads carry identifiers only, so Harbour fetches each record.

Outbox events consumed:
- `scheduling.shift.published`, `scheduling.shift.changed` and `scheduling.shift.cancelled`;
- `scheduling.clock_event.recorded`;
- `scheduling.timesheet.approved` and `scheduling.pay_period.closed`;
- `workforce.offer.accepted`.

Events emitted:
- `integrations.hr_link.person_linked`;
- `integrations.hr_link.sync_failed`;
- `integrations.hr_link.stale`;
- `integrations.hr_link.drift_detected`.

Every write that the sync makes is an audit event with the actor `integration:thapsus_hr` and
opaque identifiers only.

### 11.7 Offline and clinical safety

The phone never talks to Thapsus-HR. Clock events reach Harbour first through sync and are
forwarded from there. The rota on the device shows the staleness notice from its last sync.

HZ-133 is the hazard: staff data from the HR platform out of date, matched to the wrong person, or
changed outside its owner. Its controls are rules 2, 3, 8, 9 and 13 above. Its tests are named
after the hazard. HZ-123 and HZ-124 gain linked-tenant tests in slice 88.

### 11.8 Data protection

**Roles.** The provider is the controller for both products. Whether Thapsus-HR is Harbour's
sub-processor or the provider's own processor is H-1341.

**The new purpose (B3).** Sharing staff records, rota, clocking, absence dates and pay units with
the provider's HR platform. Lawful bases: the employment contract and legal obligations (minimum
wage, working time, SSP). For sickness dates, Article 9(2)(b). The purpose number and the DPO's
confirmation are set when slice 87 merges. DPIA risk R30 covers wrong matching, out-of-date data
and over-sharing.

Fields that cross, by flow:

| Flow | Fields |
| --- | --- |
| Employee to Harbour | Thapsus-HR identifier, employee number, names, work email, work phone, date of birth (for matching only), job title, location, contracted hours, start date, leaving date |
| Starter to Thapsus-HR | Names, work email, date of birth, job title, location, contracted hours, start date |
| Absence to Harbour | Thapsus-HR identifier, employee, type (leave, sickness or other), start, end, status |
| Shift to Thapsus-HR | Harbour reference, employee, location, role, start, end, break minutes, sleep-in flag |
| Clock event to Thapsus-HR | Harbour reference, employee, kind (in or out), time, location; no GPS position |
| Pay units to Thapsus-HR | Employee, pay period, pay code, units |
| Rate to Harbour | Employee, hourly rate, effective from |

**Transfers.** Nothing leaves the UK. Rule 1 enforces this.

**Retention.**
- Links follow the staff file's class.
- Copies of absences follow the rotas and timesheets class.
- The delivery log is kept for 12 months.

**Notice.** The provider's staff privacy notice template gains a sentence naming the HR platform as
a recipient.

### 11.9 What Thapsus-HR must add (H-1343)

Thapsus-HR's `/v1` changes only by adding things, so each item below is additive:

1. Webhook events, carrying identifiers only:
   - `shift.created`, `shift.changed` and `shift.cancelled`;
   - `leave.approved` and `leave.cancelled`;
   - `sickness.recorded` and `sickness.ended`;
   - `timesheet.approved`.
2. Shifts and clock events owned by a partner:
   - a `partner` source with a partner reference;
   - lookup by that reference;
   - partner-owned shifts read-only in Thapsus-HR's screens.
3. A pay inputs route and scope that accept units by pay code for each employee and pay period,
   idempotent by partner reference. Today `/v1/payroll` is closed to API clients.
4. A narrow read of hourly pay rates and pay periods, giving rate and effective dates only.
5. Thapsus-HR's outbound rules accepting Harbour's webhook receiver host.

Until these ship, Harbour builds and tests against the mock. Only the flows marked available in
section 11.2 can go live.

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
