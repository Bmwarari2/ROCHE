# A phone's lost key is put on record with a review (H-1531)

Branch `feat/mobile-key-invalidated`, from main. Migration 0159 (renumbered from a
provisional 0154 at the lead's request, after main's 0158).

- **Its own route.** `POST /v1/sync/key-lost` (contract `SyncKeyLost`). The staff route
  `POST /v1/sync/discards` never takes the kind. The server writes the deletion record itself:
  - kind `key_invalidated`, with a new `cause` column set to `device_key_lost`;
  - no reason code, no deleter and no ids.
  - Checks `device_discard_record_reason` and `device_discard_record_cause` allow a null reason and
    a cause only for this kind.
- **One transaction.** The record, its audit event `sync.device.key_lost` and the review
  `sync.device_key_lost` are written together. A replay raises the review if it is missing. The
  review joins the open sync-task index.
- **Bound to the device.**
  - The report must come from a session signed in on a phone.
  - It must name a lost device this organisation knows; otherwise it is refused with an audited
    problem and no review.
  - The sender need not have used the lost device. On a shared phone the next person signed in
    sends it, and the review says whether they used it.
- **One record per lost database,** by its device id (index `device_discard_record_key_lost_key`).
  - A retry under any id raises nothing more.
  - Another member's report of it is audited and changes nothing.
  - A replay rebuilds a missing review from the record, not from the replay's body.
- **Limits.** At most 3 a day per member and 2 a day per phone, taken under a lock on the phone.
  Never from a family portal session.
- **What counts.**
  - The owner counts only when an active member and either the sender or bound to the device;
    otherwise the name is kept as a claim.
  - The count is the higher of the phone's and the device's last report.
- **The review.**
  - It is always urgent.
  - It goes where the owner worked.
  - No later report closes it. Neither its sender nor the owner can close it.
  - It is never skipped or cancelled, and is done only with a coded outcome
    (`KEY_LOST_REVIEW_OUTCOMES`).
  - The old device's open hold tasks are linked to it, and left for whoever may close them.
  - Only the sender's replay raises a missing review.
  - It names the owner or claimed owner, the sender, whether they differ (a shared phone), whether
    the sender used the device, the device, the count, the phone's last sync and the server's last
    report.
- **On the phone.** `openVault` keeps a `keyLostTombstone` when it replaces a key that no longer
  opens the database. It takes the hold's owner, count and places, else the person signed in. One
  keystore slot is always free for it, and it is kept with no organisation known. It is sent to the
  new route.
- **Reviews.** Two clinical and two security reviews were run.
  - The first round asked for the review in the same transaction, routing to the owner, a credible
    owner and device, a count, no person ids and a quota.
  - The re-reviews asked for the hold tasks to be linked rather than closed, for the review never to
    be skipped or cancelled, for an always-urgent review that never takes a lower count, for no
    portal sessions or inactive owners, and for the owner to be barred from closing it.
  - All of these are done.
  - The final round asked for retries under a new id to raise nothing, a lock on the phone for its
    limit, replays built from the record, the claimed owner barred from closing, and reports from a
    shared phone's next user taken rather than refused.
  - The CSO decisions and residual risks are in H-1534.
- **Tests.**
  - `hazard HZ-006 a device's lost key is put on record with a review (H-1531)` in
    apps/api/test/device-integrity.test.ts.
  - The phone's test of the same name in tombstones.test.ts.
- **Docs.** Hazard log HZ-006, data-standards, care.md section 6 and the export catalogue.
- **Not done here.**
  - The reset notice (from #208) gives the count of lost entries but does not yet say a review was
    raised; that follows separately.
  - The H-1531 row in human-actions.md is marked built here, now that #208 is merged.
  - Nothing on the web lists device deletions or counts them today, so there is no history line or
    report count to add yet.
