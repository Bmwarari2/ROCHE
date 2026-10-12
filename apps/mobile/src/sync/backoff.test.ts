import { describe, expect, it } from "vitest";
import { type BackoffPolicy, backoffDelay, retryWithBackoff, UPLOAD_BACKOFF } from "./backoff";

const policy: BackoffPolicy = { baseDelayMs: 1000, maxDelayMs: 8000, maxAttempts: 4 };

describe("backoffDelay (full jitter)", () => {
  it.each([
    [0, 1000],
    [1, 2000],
    [2, 4000],
    [3, 8000],
    [4, 8000],
    [10, 8000],
  ])("retry %i has a ceiling of %i ms", (retry, ceiling) => {
    expect(backoffDelay(retry, policy, () => 0.999_999)).toBe(ceiling - 1);
    expect(backoffDelay(retry, policy, () => 0)).toBe(0);
    expect(backoffDelay(retry, policy, () => 0.5)).toBe(ceiling / 2);
  });
});

describe("retryWithBackoff", () => {
  const transient = new Error("transient");
  const fatal = new Error("fatal");
  const classify = (error: unknown) => ({ retry: error === transient });

  it("returns at once when the first attempt succeeds", async () => {
    const sleeps: number[] = [];
    const result = await retryWithBackoff(async () => "ok", {
      policy,
      classify,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toBe("ok");
    expect(sleeps).toEqual([]);
  });

  it("retries transient failures with growing waits, then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await retryWithBackoff(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw transient;
        return attempt;
      },
      {
        policy,
        classify,
        random: () => 0.5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toBe(3);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw transient;
        },
        {
          policy,
          classify,
          random: () => 0.5,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    ).rejects.toBe(transient);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw fatal;
        },
        { policy, classify, sleep: async () => {} },
      ),
    ).rejects.toBe(fatal);
    expect(calls).toBe(1);
  });

  it("honours a server Retry-After hint, capped at the maximum delay", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls === 1) throw transient;
        if (calls === 2) throw transient;
        return "ok";
      },
      {
        policy,
        classify: () => ({ retry: true, afterMs: calls === 1 ? 3000 : 60_000 }),
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(sleeps).toEqual([3000, 8000]);
  });

  it("waits the firewall's full 300 seconds on upload, and caps a longer hint at 10 minutes", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw transient;
        return "ok";
      },
      {
        policy: UPLOAD_BACKOFF,
        classify: () => ({ retry: true, afterMs: calls === 1 ? 300_000 : 3_600_000 }),
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(UPLOAD_BACKOFF.maxRetryAfterMs).toBeGreaterThan(300_000);
    expect(sleeps).toEqual([300_000, UPLOAD_BACKOFF.maxRetryAfterMs]);
  });

  it("reports each retry", async () => {
    const seen: number[] = [];
    let calls = 0;
    await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 2) throw transient;
        return "ok";
      },
      {
        policy,
        classify,
        random: () => 0,
        sleep: async () => {},
        onRetry: ({ attempt }) => seen.push(attempt),
      },
    );
    expect(seen).toEqual([1]);
  });
});
