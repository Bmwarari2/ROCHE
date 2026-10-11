import { describe, expect, it } from "vitest";
import { isStale, syncAgeMs } from "./staleness";

const now = new Date("2026-10-09T13:05:00Z");
const threshold = 15 * 60_000;
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("syncAgeMs", () => {
  it("is null when never synced", () => {
    expect(syncAgeMs(null, now)).toBeNull();
  });

  it("is zero, not negative, when the last sync is in the future", () => {
    expect(syncAgeMs(new Date(now.getTime() + 60_000), now)).toBe(0);
  });

  it("is the elapsed time otherwise", () => {
    expect(syncAgeMs(ago(90_000), now)).toBe(90_000);
  });
});

describe("isStale", () => {
  it.each([
    ["never synced", null, true],
    ["just synced", ago(0), false],
    ["exactly at the threshold", ago(threshold), false],
    ["one millisecond past the threshold", ago(threshold + 1), true],
    ["hours old", ago(5 * 60 * 60_000), true],
    ["clock moved backwards", new Date(now.getTime() + 60_000), false],
  ])("%s", (_label, lastSyncedAt, expected) => {
    expect(isStale(lastSyncedAt, now, threshold)).toBe(expected);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects a threshold of %s", (value) => {
    expect(() => isStale(ago(0), now, value)).toThrow(RangeError);
  });
});
