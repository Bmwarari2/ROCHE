# A phone's withdrawal confirms the exact count the manager saw (H-1535, HZ-006)

Branch `feat/web-device-withdraw-exact-count`, after #217. No migration.

- **Contract.** `RevokeDevice` takes an optional `confirmedEntriesWaiting: { count, reportedAt }`:
  the entries the device last reported waiting, and when, as the manager saw them (`reportedAt` is
  null when it never reported). `confirmEntriesWaiting` stays for older clients.
- **API.** `POST /v1/devices/{deviceId}/revoke` refuses with 409 `entries_waiting`
  (`problems.entriesChanged`) when the count or the report time is now different. Nothing is
  revoked then.
  - `revokeDevice` reads the count under the lock the device's reports take.
  - It checks only after the caller's reach, so a device out of reach reads as not found and no
    count is told.
  - It returns the fresh count for the hold and the response.
  - The bare `confirmEntriesWaiting` is deprecated: taken only when nothing is waiting, and
    refused together with the exact confirmation.
  - The audit records which confirmation was used.
- **Web.** The withdraw form always sends what the manager saw. A refusal asks them to reload and
  tick again, as before.
- **Decision.** This is the safer default the lead chose for H-1535. It is provisional, for the
  CSO to confirm.
- **Tests.**
  - `hazard HZ-006 a withdrawal confirms the exact count the manager saw (H-1535)` in
    apps/api/test/device-integrity.test.ts. It is table-driven: the same count and report, higher,
    lower, the same count reported again later, and never reported.
  - The form test checks the count and the report time it sends.
- **Docs.** Hazard log HZ-006 and H-1535.
- **Generated.** OpenAPI and the client are regenerated.
- Security and clinical reviews (High: the check ran outside the revocation's transaction and
  before the reach check). Fixed as above; the web refusal wording is now neutral; the deleted
  never-reported test is restored.
