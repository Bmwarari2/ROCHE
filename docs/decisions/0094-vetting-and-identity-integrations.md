---
status: "proposed"
date: 2026-10-31
decision-makers: Brian (product owner), the data protection lead (DPO)
consulted: the clinical safety officer (CSO) on the staff file's rostering rule (HZ-124)
informed: the lead engineer
---

# Vetting and identity integrations: ports with mocks, off until an organisation configures them

## Context and problem statement

Schedule 3 of the Regulated Activities Regulations 2014 needs proof of identity, the right to work,
an enhanced DBS certificate with the adults' barred list and, for nurses, a current NMC
registration before someone works (workforce.md rules 1 to 4 and 8). Slice 11 records each check by
hand with uploaded evidence. Electronic routes exist: certified identity service providers (IDSPs)
for British and Irish citizens' right to work, the DBS e-bulk service through a registered or
umbrella body, the DBS Update Service for status checks, and the NMC register. No provider is
chosen or contracted (H-521, H-522, H-523), the NMC offers no API, and DBS results are criminal
offence data (Article 10 UK GDPR). Phase 2 plan slice 77 asks for the integrations without real
vendor calls.

## Decision drivers

- Manual entry must keep working for every organisation, with or without a provider.
- Nothing reaches a vendor until the organisation has contracted it and the DPO has assessed it
  (H-520, H-793): where the data is held, Article 28 terms, security assurance.
- A vendor's answer is evidence for a person to accept, not a decision (no solely automated
  significant decisions, master prompt section 5.1).
- The least personal data each vendor needs, and nothing a DBS certificate disclosed, ever.
- The worker's consent where the DBS requires it (the e-bulk application and Update Service
  status checks), recorded and withdrawable.

## Considered options

- Ports with contract-tested mocks, off per organisation until configured, results applied by a
  person (chosen).
- Build against one vendor's API now.
- Manual entry only until vendors are chosen.

## Decision outcome

Chosen option: "Ports with contract-tested mocks", because it keeps the manual default, lets each
vendor be added later as one adapter that passes the same contract tests, and keeps every vendor
call behind the organisation's own configuration.

- **Four ports**, named as `integration_connection.port`: `workforce.idsp` (right to work, British
  and Irish passports and the Irish passport card only), `workforce.dbs_ebulk` (applications),
  `workforce.dbs_update_service` (status checks) and `workforce.nmc_register` (PIN checks). Each
  takes an opaque reference (the check's id, so a retry is the same request) and answers pending,
  completed with a result, or failed. Request fields are fixed per port
  (`VETTING_REQUEST_FIELDS`).
- **Off by default.** A port is on only when the organisation has an `integration_connection` row
  for it with a provider this build knows. The only provider is `mock`, which is refused in
  production at configuration and at use. Configuring a vetting port needs
  `integrations.connection.manage` with a fresh step-up. The NMC has no API (H-523): the port and
  its mock exist so a confirmation service can be added if the NMC offers one; the register is never
  scraped, and the manual check stays.
- **Results are applied by a person.** A completed check is stored with its result (strictly
  parsed: an unexpected field is refused, so certificate content cannot arrive). A holder of
  `workforce.staff_file.manage`, never the worker, applies it: the item is verified in their name
  on the check's date, `compliance_item.evidence_source` names the check and `vetting_check_id`
  links it. Results that are not evidence (not verified, withdrawn, details not matched, not
  registered, registered with conditions) are never applied; the item stays as it was for HR to
  deal with by hand.
- **Consent.** `vetting_consent` records the worker's consent to a DBS application or to Update
  Service status checks, with the date given and who recorded it, and its withdrawal. A DBS check
  does not start without the matching consent in force on the day.
- **Migration 0120**: `vetting_consent`, `vetting_check`, and two columns on `compliance_item`
  (`evidence_source`, default `manual`, and `vetting_check_id`), expand only.

### Consequences

- Good, because nothing changes for an organisation that configures nothing, and the manual route
  stays the default.
- Good, because a future vendor is one adapter class plus its sandbox run of the shared contract
  suite, with no schema or screen change.
- Good, because the DBS result kept is the same minimum the manual route keeps (H-575).
- Bad, because until vendors are contracted the electronic routes are exercised only by mocks.
- Neutral, because each vendor joins the sub-processor register or is recorded as the
  organisation's own processor (H-520) before it is added.

### Confirmation

- `packages/domain/src/workforce/vetting.test.ts`: the request and application rules, table-driven.
- `apps/api/src/integrations/vetting.contract.ts`, run by `vetting.test.ts` against every mock
  scenario: answers parse with the port's strict schema, retries are idempotent, requests carry only
  the declared fields, and the mock refuses to run in production.
- `packages/db/test/vetting.test.ts` and `apps/api/test/vetting.test.ts`: isolation, the worker never
  writes, consent required, ports off by default, results applied only by a person.

## Pros and cons of the options

### Build against one vendor's API now

- Good, because real responses would be tested sooner.
- Bad, because no vendor is chosen or contracted, and sandbox credentials do not exist (H-521).

### Manual entry only

- Good, because it is already built.
- Bad, because the plan's slice 77 and WORK-002 ask for the electronic routes, and adding them later
  would mean schema and screen changes then.

## More information

Phase 2 plan, ADR-0094 row and slice 77; workforce.md section 2e and rule 24; human actions H-520
to H-523, H-793 and H-1120 to H-1129; [sub-processors.md](../compliance/sub-processors.md).
