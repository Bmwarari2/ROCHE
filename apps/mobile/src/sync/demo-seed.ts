import type { AbstractPowerSyncDatabase } from "@powersync/common";
import { DEMO_SEEDED_AT_KEY, demoSeedStatements } from "../demo/demo-data";

/**
 * Seeds the demo database once and returns when it was seeded, which the banner shows in place of
 * a last sync time. The demo schema is local-only, so nothing enters the upload queue.
 */
export async function seedDemoDatabase(db: AbstractPowerSyncDatabase): Promise<Date> {
  const existing = await db.getOptional<{ value: string }>(
    "SELECT value FROM sync_meta WHERE key = ?",
    [DEMO_SEEDED_AT_KEY],
  );
  if (existing) {
    const at = new Date(existing.value);
    if (!Number.isNaN(at.getTime())) return at;
  }
  const seededAt = new Date();
  await db.writeTransaction(async (tx) => {
    for (const statement of demoSeedStatements(seededAt)) {
      await tx.execute(statement.sql, [...statement.params]);
    }
  });
  return seededAt;
}
