import { describe, expect, it } from "vitest";
import { all, openLocalDatabase } from "../test-support/local-db";
import {
  DMD_SUBSET_REFRESH_MS,
  parseDeviceSubset,
  replaceSubsetStatements,
  subsetDue,
} from "./dmd-subset";

/**
 * The phone's dm+d subset (ADR-0130; integrations.md section 12 rule 9; slice 68; HZ-113): read
 * only when it is as the contract says, and replaced whole, so a pack that left the subset never
 * matches a scan. Invented codes in the 9000 range.
 */

const subset = {
  products: [
    {
      kind: "vmp",
      id: "90000011000001104",
      name: "Paracetamol 500mg tablets",
      vmpId: "90000011000001104",
      ampId: null,
      vmppId: null,
      invalid: false,
      supersededBy: null,
    },
    {
      kind: "ampp",
      id: "90000031000001108",
      name: "Paracetamol 500mg tablets (Example) 32",
      vmpId: "90000011000001104",
      ampId: "90000021000001106",
      vmppId: "90000041000001102",
      invalid: false,
      supersededBy: null,
    },
  ],
  gtins: [
    { gtin: "05000000000001", amppId: "90000031000001108", startDate: "2026-01-01", endDate: null },
  ],
  unresolved: ["90000099000001100"],
};

describe("the phone's dm+d subset", () => {
  it("reads the API's answer only when it is as the contract says", () => {
    expect(parseDeviceSubset(subset)).not.toBeNull();
    expect(parseDeviceSubset({ ...subset, gtins: [{ ...subset.gtins[0], gtin: "x" }] })).toBeNull();
    expect(
      parseDeviceSubset({ ...subset, products: [{ ...subset.products[0], id: "1; DROP" }] }),
    ).toBeNull();
    expect(parseDeviceSubset({ products: [] })).toBeNull();
  });

  it("replaces the subset whole on the phone's schema, with the products the data lacks named", async () => {
    const db = await openLocalDatabase();
    const run = (s: { sql: string; params: unknown[] }) => db.prepare(s.sql).run(...s.params);
    const parsed = parseDeviceSubset(subset);
    if (!parsed) throw new Error("not parsed");
    for (const s of replaceSubsetStatements(parsed, new Date("2026-11-06T10:00:00Z"))) run(s);
    // A second fetch without the pack leaves no trace of it.
    const smaller = { ...parsed, products: parsed.products.slice(0, 1), gtins: [] };
    for (const s of replaceSubsetStatements(smaller, new Date("2026-11-06T11:00:00Z"))) run(s);
    expect(
      all<{ id: string; kind: string }>(
        db,
        "SELECT id, kind FROM dmd_device_product ORDER BY id",
        [],
      ),
    ).toEqual([
      { id: "unresolved:90000099000001100", kind: "unresolved" },
      { id: "vmp:90000011000001104", kind: "vmp" },
    ]);
    expect(all(db, "SELECT gtin FROM dmd_device_gtin", [])).toEqual([]);
  });

  it.each([
    ["never fetched", null, true],
    ["fetched just now", "2026-11-06T10:00:00.000Z", false],
    [
      "fetched an hour ago",
      new Date(Date.parse("2026-11-06T10:00:00Z") - DMD_SUBSET_REFRESH_MS).toISOString(),
      true,
    ],
    ["fetched in the future (a wrong clock)", "2026-11-07T10:00:00.000Z", true],
  ])("asks again when %s", (_case, last, due) => {
    expect(subsetDue(last, new Date("2026-11-06T10:00:00Z"))).toBe(due);
  });
});
