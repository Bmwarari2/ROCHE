# A phone's lost key is put on record with a review (H-1531)

Branch `feat/mobile-key-invalidated`, from main. Migration 0154 (provisional number; the lead
confirms it at merge).

- **Its own route.** `POST /v1/sync/key-lost` (contract `SyncKeyLost`). The staff route
  `POST /v1/sync/discards` never takes the kind. The server writes the deletion record itself:
  - kind `key_invalidated`, with a new `cause` column set to `device_key_lost`;
  - no reason code, no deleter and no ids.
  - Checks `device_discard_record_reason` and `device_discard_record_cause` allow a null reason and
    a cause only for this kind.
- **One transaction.** The record, its audit event `sync.device.key_lost` and the review
  `sync.device_key_lost` are written together. A replay raises the review if it is missing. The
  review joins the open sync-task index.
- **Who sends it.** Any member of the organisation, up to 3 a day.
- **What counts.**
  - The owner counts only when on the staff and either the sender or bound to the device.
  - The device counts only when the sender or owner used it.
  - Otherwise each is audited as a claim.
  - The count comes from the hold, else from the device's last report.
- **The review.**
  - It is urgent unless that count is 0.
  - It goes where the owner worked.
  - No later report closes it, and its sender cannot.
  - It is done only with a coded outcome (`KEY_LOST_REVIEW_OUTCOMES`).
  - The old device's hold tasks close as superseded by it.
- **On the phone.** `openVault` keeps a `keyLostTombstone` when it replaces a key that no longer
  opens the database. It takes the hold's owner, count and places, else the person signed in. One
  keystore slot is always free for it, and it is kept with no organisation known. It is sent to the
  new route.
- **Reviews.** The clinical and security reviews of the first cut asked for the review in the same
  transaction, routing to the owner, a credible owner and device, a count, no person ids, a quota,
  the hold task superseded and a coded outcome. All of these are done.
- **Tests.**
  - `hazard HZ-006 a device's lost key is put on record with a review (H-1531)` in
    apps/api/test/device-integrity.test.ts.
  - The phone's test of the same name in tombstones.test.ts.
- **Docs.** Hazard log HZ-006, data-standards, care.md section 6 and the export catalogue.
- **Not done here.**
  - The reset notice telling the person a review was raised lives in #208, and follows after it
    merges.
  - The H-1531 row in human-actions.md is on #208's branch.
  - Nothing on the web lists device deletions or counts them today, so there is no history line or
    report count to add yet.
