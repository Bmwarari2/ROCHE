# Disclosure requests (SAFE-016)

Branch `feat/safety-disclosure-requests`, stacked on `feat/platform-dsar-workbench` (#149).

## What changed

- Spec: [safety.md](../specs/safety.md) section 11, rules 38 to 44, with the permission matrix and
  the test list. Rate `coroner.prevention_report_response_days` (56 days, to verify, H-822).
- Migration 0103: `disclosure_request` and `disclosure_item`, forced row-level security. A member
  sees and works requests about people at homes their `safety.incident.manage` or
  `safety.disclosure.approve` reaches; requests are logged in one's own name; the approver is never
  the person who logged it (check and trigger); released, refused and withdrawn requests are frozen
  except a coroner's Regulation 28 dates; items change only while the request is worked; the
  system context reads for the full export and never writes.
- API `/v1/disclosures`: log (legal basis stored for the type; an Access to Health Records Act
  request needs the person to have died and gets its due date from `ahra.*` rates), collect with
  the DSAR collector (ADR-0090), review each record with highlights of other people's names (fresh
  step-up), decide on the record as opened, prepare, approve or refuse, release with a fresh
  step-up, fetch the pack as issued (fresh step-up), withdraw, and record a Regulation 28 report.
  The pack is in date order, hashed and stored in the exports bucket under
  `disclosurePackStorageKey` (UUIDs only); the storage key check accepts that prefix.
- The disclosure log itself is never collected into a pack (H-824).
- Records of processing (disclosure requests note), data standards (code lists), feature register.

## Found, not fixed here

- No web screens yet (H-829).

## Human actions logged

- H-820 to H-829.

## Tests

- Database: `disclosure-requests.test.ts` 3 passed. API: `disclosures.test.ts` 12 passed. Domain:
  `disclosure.test.ts` with the pack key.
