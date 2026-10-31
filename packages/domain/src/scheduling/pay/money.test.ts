import { describe, expect, it } from "vitest";
import { canonicalInput, formatPounds, percentOf } from "./money";

describe("whole-pence arithmetic (ADR-0086)", () => {
  it.each([
    [10_000, 12.07, 1207],
    [999, 12.07, 120],
    [12_345, 80, 9876],
    [1, 90, 0],
    [0, 50, 0],
  ])("%ip at %s%% is %ip, rounded down", (pence, percent, expected) => {
    expect(percentOf(pence, percent)).toBe(expected);
  });

  it.each([
    [0, "£0.00"],
    [5, "£0.05"],
    [123_456, "£1,234.56"],
    [-250, "-£2.50"],
  ])("writes %ip as %s", (pence, text) => {
    expect(formatPounds(pence)).toBe(text);
  });

  it("serialises inputs the same way whatever the key order", () => {
    expect(canonicalInput({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      canonicalInput({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }),
    );
    expect(canonicalInput({ a: 1 })).not.toBe(canonicalInput({ a: 2 }));
  });
});
