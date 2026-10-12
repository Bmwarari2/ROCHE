import { describe, expect, it } from "vitest";
import { RateLimiter, requireWithinLimit } from "../src/http/rate-limit";

describe("the per-user limit on the transfer pack routes (S2)", () => {
  it("hazard HZ-023 lets a user make a few packs a minute and asks the rest to wait, without stopping others", () => {
    const limiter = new RateLimiter(3, 60_000);
    const t0 = Date.parse("2026-10-11T10:00:00Z");
    expect([0, 1, 2].map((n) => limiter.take("nurse", t0 + n * 1000))).toEqual([null, null, null]);
    expect(limiter.take("nurse", t0 + 3000)).toBe(57);
    expect(limiter.take("manager", t0 + 3000)).toBeNull();
    expect(limiter.take("nurse", t0 + 61_000)).toBeNull();
  });

  it("answers 429 with how long to wait", () => {
    const limiter = new RateLimiter(1, 60_000);
    requireWithinLimit(limiter, "carer");
    try {
      requireWithinLimit(limiter, "carer");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ status: 429, code: "rate_limited" });
      expect((error as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
    }
  });
});
