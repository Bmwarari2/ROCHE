import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drizzle applies a pending migration only if its journal `when` is later than the last one
 * applied, so a migration whose `when` is out of order is skipped without a word (#97 review,
 * H). Every entry must follow the one before it: `idx` and `when` strictly increasing, each tag
 * numbered with its `idx` (0056 was never used, so numbers may skip), and each tag's SQL file
 * present. When parallel branches land, the
 * later one merges main and regenerates its entry with drizzle-kit before it merges.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const journal = JSON.parse(readFileSync(`${DRIZZLE}meta/_journal.json`, "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("the migration journal applies every migration in order", () => {
  it.each(journal.entries.map((e, position) => [e.tag, e, position] as const))(
    "%s is in its place",
    (_, entry, position) => {
      expect(Number(entry.tag.slice(0, 4))).toBe(entry.idx);
      expect(existsSync(`${DRIZZLE}${entry.tag}.sql`)).toBe(true);
      const before = journal.entries[position - 1];
      if (before) {
        expect(entry.idx).toBeGreaterThan(before.idx);
        expect(entry.when).toBeGreaterThan(before.when);
      }
    },
  );
});
