# Identity and vetting adapters (slice 77, WORK-002, ADR-0094)

Branch `feat/work-vetting-adapters`, cut from `feat/web-workforce-people`. Phase 2 plan slice 77:
four ports for the staff file's electronic checks, with contract-tested mocks, each off until an
organisation switches it on. Manual entry with uploaded evidence stays the default, and no vendor
is chosen (H-521 to H-523), so no vendor is called.

## What changed

- **ADR-0094 (proposed, H-1126):** ports for a certified identity service provider (right to work), DBS e-bulk applications, DBS Update Service status checks and the NMC register.
  - Each port is off until the organisation configures a provider this build knows. The only provider is the mock, which is refused in production.
  - A result changes nothing by itself: HR applies it.
- **Domain** (`packages/domain/src/workforce/vetting.ts`):
  - The ports' request and result types, and the only fields each port is sent (`VETTING_REQUEST_FIELDS`).
  - `vettingRequestProblem`: a check may start only on someone else's file, with its port on and none pending. An IDSP checks British and Irish passports and the Irish passport card only. A DBS check needs the worker's consent in force on the day. A status check needs a subscribed certificate's number and the date of birth. An NMC check needs an NMC role with a PIN.
  - `vettingApplication`: what each outcome does to the item. Not verified, withdrawn, details not matched, not registered and registered with conditions are never applied.
  - `vettingCheckStillMatches`: no result is applied once the certificate number or PIN has changed.
- **Migration 0120** (expand only):
  - `vetting_consent`: given and withdrawn once, in the recorder's own name, one in force per purpose.
  - `vetting_check`: moves forward only, keeps what it checked, applied once in the applier's own name.
  - `compliance_item.evidence_source` and `vetting_check_id`. The guard lets an item name a check only once that check, of its file and kind, was applied by the item's writer.
  - Forced RLS following the staff file: the worker reads their own and writes none. History visible to staff file readers.
- **Adapters** (`apps/api/src/integrations/vetting.ts`):
  - `MockVetting` is stateless and deterministic, answering from its connection's `scenario`.
  - `strictVetting` sends only the declared fields and parses answers strictly, so a DBS answer carrying anything the certificate disclosed fails. Provider error text becomes a short code.
  - `createVettingAdapter` answers null (off) without a connection, for an unknown provider, and for the mock in production.
- **API:**
  - `GET /v1/workforce/vetting/ports`.
  - `GET /v1/workforce/staff-files/{id}/vetting`.
  - Consents: record, and withdraw.
  - Checks: start, refresh and apply. The vendor is called outside any transaction: the check is stored pending first, then its answer.
  - Applying verifies the item in the caller's name on the check's date, with the check as its source. An IDSP check needs the checker to confirm the photograph is of the worker.
  - `PUT /v1/integrations/{port}` takes the vetting ports with a fresh step-up. A new `DELETE /v1/integrations/{port}` switches a vetting port off.
  - Recording an item by hand sets its source back to `manual`.
  - Every change and refusal is audited by ids and codes.
- **Docs:**
  - workforce.md: section 2e, rule 24, the API rows, the test list and known gaps.
  - Records of processing (B3, Article 10 for DBS results).
  - The sub-processor register's pending vetting entries.
  - Data standards, retention, the export catalogue, the feature register (WORK-002), and human actions H-1120 to H-1129.

## Security review

No high findings; all medium and low findings fixed:

- **M1:** every read of a file's vetting record is audited (`workforce.vetting.viewed`).
- **M2:** a pending check that never reached the provider is refused on refresh as `not_sent`, and any pending check can be cancelled (`POST .../checks/{checkId}/cancel`).
- **L1:** the database names a check as an item's source only when the same transaction applied it, and refuses any change under that label.
- **L2:** withdrawn consent stops a pending DBS check being asked about, stored or applied, in the API and the database. An answer arriving afterwards fails the check as `consent_withdrawn`.
- **L3:** storing the provider's answer is audited (`workforce.vetting_check.answered`, state and error code only). A write that changes no row is a conflict.
- The ADR and H-1125 note that the mock's refusal relies on `NODE_ENV=production` in every deployment holding real data.

## Tests

- `packages/domain/src/workforce/vetting.test.ts` (46, table-driven): ports and sources line up, consent on the day, every start problem, every outcome of every port, and changed certificates and PINs.
- `apps/api/src/integrations/vetting.test.ts` (100): the shared contract suite (`vetting.contract.ts`) on every mock scenario, the mock's answers, the chooser off by default, strict answers.
- `packages/db/test/vetting.test.ts`: isolation, the worker writing nothing, consent and check guards, the evidence source guard, nothing deleted.
- `apps/api/test/vetting.test.ts` (17): ports off by default, switching on and off with step-up, permissions, and the NMC, IDSP, DBS e-bulk and Update Service journeys. Also outcomes never applied, a replaced certificate and consent withdrawn.
- `operator-and-integrations.test.ts`: the ports list now includes the vetting ports.

## Known gaps

- No screens (with slice 56, H-1129).
- No vendor adapters (H-1120 to H-1123).
- Pending checks are refreshed by hand.
- The worker's own consent is recorded by HR (H-1128).
