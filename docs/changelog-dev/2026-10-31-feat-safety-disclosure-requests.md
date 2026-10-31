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

## Security review

- Fixed: a release blocked by a changed record no longer claims to reset items (an approved
  request's items are fixed); request and item history in `record_version` is read only by those
  who may read the request (restrictive policy in 0103); every read checks the member's reach in
  the API as well as row-level security; logging a request reads only the person's home before the
  reach check, and a person at another home reads as not found; the decision route reads the record
  outside the member's transaction (one connection at a time); `asOrganisation` runs read-only.

## Found, not fixed here

- No web screens yet (H-829).
- Acting-up grants count in the API's reach check but not in `app.holds_role_permission_at`, so an
  acting-up approver is refused by the database (fails closed). For the lead to decide platform-wide.
- The item view authorises in one transaction and reads the record in the next: a role revoked in
  between still sees that one record. Accepted as a narrow window, as in the DSAR workbench.

## Human actions logged

- H-820 to H-829.

## Tests

- Database: `disclosure-requests.test.ts` 3 passed. API: `disclosures.test.ts` 12 passed (step-up on the item view added). Database: the history policy test added. Domain:
  `disclosure.test.ts` with the pack key.
