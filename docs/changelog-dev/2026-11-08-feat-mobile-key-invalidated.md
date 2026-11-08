# A phone's lost key is put on record with a review (H-1531)

Branch `feat/mobile-key-invalidated`, from main. Migration 0154 (provisional number; the lead
confirms it at merge).

- **New discard kind.** `key_invalidated` is added to the contract (`SYNC_DISCARD_KINDS`), the
  phone (`DISCARD_KINDS`) and the table's check. It is a loss nobody chose, so it has:
  - no reason code (`reasonCode` null, allowed for this kind only, by the contract and by
    `device_discard_record_reason`);
  - no deleter and no entry ids (`idsMissing` `key_invalid`);
  - only the "deleted" stage.
- **Any member may send it.** The API skips the reason lookup and the manager check. It raises an
  urgent `sync.device_key_lost` task, due at once, for the holders of `safety.incident.manage`
  where the owner or the sender works. No later report from the device closes it.
- **On the phone.** When `openVault` replaces a key that no longer opens the database, it keeps a
  `keyLostTombstone`, which goes after the next sync. The tombstone carries the hold's
  organisation, owner and count, or the signed-in organisation when nothing was held.
- **Tests.**
  - `hazard HZ-006 a device's lost key is put on record with a review (H-1531)` in
    apps/api/test/device-integrity.test.ts.
  - The phone's test of the same name in tombstones.test.ts.
- **Docs.** Hazard log HZ-006, data-standards and care.md section 6.
- **Still to do.** The H-1531 row in human-actions.md is on #208's branch. It is marked built
  once #208 merges.
