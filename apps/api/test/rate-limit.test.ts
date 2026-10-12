import { describe, expect, it } from "vitest";
import { type QuotaHit, slideWindow } from "../src/http/quota";

/** Replays requests through the window the way `PerUserQuota.attempt` does, one member at a time. */
function replay(max: number, windowMs: number) {
  const store = new Map<string, QuotaHit[]>();
  return (member: string, now: number, amount = 1): number | null => {
    const { recent, waitSeconds } = slideWindow(
      store.get(member) ?? [],
      amount,
      max,
      windowMs,
      now,
    );
    if (waitSeconds === null) store.set(member, [...recent, { at: now, amount }]);
    return waitSeconds;
  };
}

describe("the per-user sliding window (S2, M4, S-M2)", () => {
  it("hazard HZ-023 lets a user make a few packs a minute and asks the rest to wait, without stopping others", () => {
    const take = replay(3, 60_000);
    const t0 = Date.parse("2026-10-11T10:00:00Z");
    expect([0, 1, 2].map((n) => take("nurse", t0 + n * 1000))).toEqual([null, null, null]);
    expect(take("nurse", t0 + 3000)).toBe(57);
    expect(take("manager", t0 + 3000)).toBeNull();
    expect(take("nurse", t0 + 61_000)).toBeNull();
  });

  it("counts an amount against the limit and refuses one that would pass it", () => {
    const t0 = Date.parse("2026-10-11T10:00:00Z");
    const hits = [{ at: t0, amount: 400 }];
    expect(slideWindow(hits, 100, 500, 3_600_000, t0 + 1000).waitSeconds).toBeNull();
    expect(slideWindow(hits, 101, 500, 3_600_000, t0 + 1000).waitSeconds).toBe(3599);
  });

  it("drops hits older than the window and waits at least a second", () => {
    const t0 = Date.parse("2026-10-11T10:00:00Z");
    const hits = [
      { at: t0 + 59_900, amount: 1 },
      { at: t0, amount: 1 },
    ];
    const later = slideWindow(hits, 1, 1, 60_000, t0 + 60_000);
    expect(later.recent).toEqual([{ at: t0 + 59_900, amount: 1 }]);
    expect(slideWindow([{ at: t0, amount: 1 }], 1, 1, 60_000, t0 + 59_999).waitSeconds).toBe(1);
  });
});
