import { readFileSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema";

/**
 * The Drizzle snapshot chain (chore/drizzle-snapshot-chain): each migration's snapshot names the
 * one before it in journal order, no two share a parent (drizzle-kit refuses to generate
 * otherwise), and the latest equals the schema in code, so the next `drizzle-kit generate`
 * writes only the next change. A branch adding a migration re-chains its snapshot onto the
 * latest one's id (docs/runbooks/drizzle-snapshots.md).
 */

const META = new URL("../drizzle/meta/", import.meta.url);
const ROOT_PARENT = "00000000-0000-0000-0000-000000000000";

interface Entry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}
interface Snapshot {
  readonly id: string;
  readonly prevId: string;
}

const journal = JSON.parse(readFileSync(new URL("_journal.json", META), "utf8")) as {
  entries: Entry[];
};
const snapshotOf = (e: Entry) =>
  JSON.parse(
    readFileSync(new URL(`${e.tag.slice(0, 4)}_snapshot.json`, META), "utf8"),
  ) as Snapshot & Record<string, unknown>;
const snapshots = journal.entries.map(snapshotOf);

describe("the Drizzle snapshot chain", () => {
  it("keeps the journal in idx order with `when` strictly increasing", () => {
    const idx = journal.entries.map((e) => e.idx);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]?.when, journal.entries[i]?.tag).toBeGreaterThan(
        journal.entries[i - 1]?.when as number,
      );
    }
  });

  it("gives every snapshot its own id and parent", () => {
    const ids = snapshots.map((s) => s.id);
    const parents = snapshots.map((s) => s.prevId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(parents).size).toBe(parents.length);
  });

  it("chains each snapshot to the one before it in journal order", () => {
    expect(snapshots[0]?.prevId).toBe(ROOT_PARENT);
    const breaks = snapshots.flatMap((s, i) =>
      i > 0 && s.prevId !== snapshots[i - 1]?.id ? [journal.entries[i]?.tag] : [],
    );
    expect(breaks).toEqual([]);
  });

  it("has the latest snapshot equal to the schema in code", async () => {
    const latest = snapshots.at(-1) as Snapshot & Record<string, unknown>;
    const current = generateDrizzleJson(schema as Record<string, unknown>, latest.id, [
      "public",
      "auth",
    ]);
    const statements = await generateMigration(
      latest as Parameters<typeof generateMigration>[0],
      current,
    );
    expect(statements).toEqual([]);
  });
});
