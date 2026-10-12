import { describe, expect, it } from "vitest";
import {
  checkDiscardReason,
  DEFAULT_DISCARD_REASONS,
  DISCARD_REASON_CODE_PATTERN,
  discardReasonStatus,
} from "./discard-reasons";

/** Coded reasons for deleting unsent entries on a device (hazard HZ-040; human action H-146). */

describe("hazard HZ-040 every organisation starts with the phone's coded reasons", () => {
  it("seeds the five codes the phone offers, in order, each a valid code", () => {
    expect(DEFAULT_DISCARD_REASONS.map((r) => r.code)).toEqual([
      "recorded_elsewhere",
      "entered_in_error",
      "staff_left",
      "nurse_in_charge_informed",
      "other",
    ]);
    for (const reason of DEFAULT_DISCARD_REASONS) {
      expect(reason.code).toMatch(DISCARD_REASON_CODE_PATTERN);
    }
    const orders = DEFAULT_DISCARD_REASONS.map((r) => r.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});

describe("hazard HZ-040 a deletion record carries a code the organisation has", () => {
  const reasons = [
    { code: "entered_in_error", retiredAt: null },
    { code: "agency_shift_ended", retiredAt: new Date("2026-10-01T09:00:00Z") },
  ];

  it.each([
    ["a live code", "entered_in_error", "live"],
    [
      "a retired code, still accepted from a device that used it before",
      "agency_shift_ended",
      "retired",
    ],
    ["a code the organisation never had", "because", "unknown"],
  ] as const)("%s", (_name, code, status) => {
    expect(discardReasonStatus(reasons, code)).toBe(status);
  });
});

describe("a new coded reason is checked before it is saved", () => {
  const existing = [{ code: "other", retiredAt: null }];

  it.each([
    ["a good code and label", "agency_shift_ended", "Agency shift ended before sync", true, null],
    ["a code with capitals", "Agency", "Agency shift ended", false, "code"],
    ["a code starting with a number", "1st", "First", false, "code"],
    ["a code with spaces", "shift ended", "Shift ended", false, "code"],
    ["a code over 40 characters", `a${"b".repeat(40)}`, "Long code", false, "code"],
    ["a code already in the list", "other", "Something else", false, "code"],
    ["a label too short", "short_label", "Ok", false, "label"],
    ["a label with a control character", "bell_label", "Shift\u0007ended", false, "label"],
  ] as const)("%s", (_name, code, label, ok, field) => {
    const check = checkDiscardReason({ code, label }, existing);
    expect(check.ok).toBe(ok);
    if (!check.ok) expect(check.field).toBe(field);
  });
});
