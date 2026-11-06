import { describe, expect, it } from "vitest";
import { emarSnapshotNotice } from "./outputs";

describe("hazard HZ-021 hazard HZ-023 a medicines list from the eMAR says what it is", () => {
  it.each([
    ["in winter", "2026-01-15T09:05:00Z", "15/01/2026 09:05 GMT"],
    ["in summer, in UK time", "2026-07-15T09:05:00Z", "15/07/2026 10:05 BST"],
  ])("says when it was produced %s, and that it is not the live record", (_n, at, words) => {
    const notice = emarSnapshotNotice(new Date(at));
    expect(notice).toContain(words);
    expect(notice).toMatch(/not the live record/);
    expect(notice).not.toMatch(/should|recommend|safe to/i);
  });
});
