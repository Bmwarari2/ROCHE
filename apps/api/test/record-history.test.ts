import { describe, expect, it } from "vitest";
import { latestChanged, sameStored } from "../src/services/record-history";

describe("record history: what the latest change altered", () => {
  it.each([
    [{ a: 1, b: [1, { c: true }] }, { b: [1, { c: true }], a: 1 }, true],
    [{ a: 1 }, { a: 1, b: null }, false],
    [{ a: 1, b: null }, { a: 1, c: null }, false],
    [[1, 2], [2, 1], false],
    [[], {}, false],
    ["2026-10-31", "2026-10-31", true],
    [null, null, true],
    [null, {}, false],
    [1, "1", false],
  ])("compares %j with %j as %s, whatever the key order", (a, b, same) => {
    expect(sameStored(a, b)).toBe(same);
  });

  const versions = [
    { version: 1, data: { version: 1, status: "draft", controls: ["Sit up"], dropped: "x" } },
    {
      version: 2,
      data: {
        version: 2,
        status: "active",
        controls: ["Sit up"],
        answers: { b: false, a: true },
        dropped: "x",
      },
    },
  ];

  it("hazard HZ-024 lists the keys the newest version differs on, sorted", () => {
    const current = {
      version: 3,
      status: "active",
      controls: ["Sit up", "Supervise"],
      answers: { a: true, b: false },
      closed_reason: null,
    };
    // A column the row no longer has is not a change; one only the row has is not in the version.
    expect(latestChanged(versions, current)).toEqual(["controls", "version"]);
    expect(latestChanged([], current)).toEqual([]);
  });

  it("hazard HZ-024 compares nothing when the row is not the version after the newest stored", () => {
    const current = { version: 4, status: "closed", controls: ["Sit up"] };
    expect(latestChanged(versions, current)).toBeNull();
    expect(latestChanged(versions, undefined)).toBeNull();
  });
});
