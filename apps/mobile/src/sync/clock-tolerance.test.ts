import { describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/http";
import { all, openLocalDatabase } from "../test-support/local-db";
import {
  CLOCK_TOLERANCE_META_ID,
  CLOCK_TOLERANCE_RATE_KEY,
  FAIL_SAFE_TOLERANCE_MINUTES,
  resolveClockTolerance,
} from "./clock-tolerance";
import type { MetaStore } from "./offline-window";

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";

async function metaStore(): Promise<MetaStore> {
  const db = await openLocalDatabase();
  return {
    getOptional: async <T>(sql: string, params: unknown[] = []) =>
      (all<T>(db, sql, params)[0] ?? null) as T | null,
    execute: async (sql: string, params: unknown[] = []) => {
      db.prepare(sql).run(...params);
      return { rowsAffected: 1 } as never;
    },
  } as unknown as MetaStore;
}

const rate = (value: unknown, unit: unknown = "minutes"): FetchLike => {
  const fetch: FetchLike = async (url) => {
    expect(url).toBe(`${API}/v1/rates/${CLOCK_TOLERANCE_RATE_KEY}`);
    return new Response(JSON.stringify({ key: CLOCK_TOLERANCE_RATE_KEY, value, unit }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return fetch;
};

const online = (fetch: FetchLike) => ({ apiUrl: API, fetch, token: "tok", tenantId: TENANT });

describe("hazard HZ-010 the clock tolerance for typed times comes from the rate table", () => {
  it("reads the tenant's figure, caches it for offline starts, and uses none until it is known", async () => {
    const db = await metaStore();
    expect(await resolveClockTolerance(db, null)).toBe(FAIL_SAFE_TOLERANCE_MINUTES);
    expect(FAIL_SAFE_TOLERANCE_MINUTES).toBe(0);
    expect(await resolveClockTolerance(db, online(rate(5)))).toBe(5);
    expect(await resolveClockTolerance(db, null)).toBe(5);
    expect(
      await db.getOptional<{ value: string }>("SELECT value FROM sync_meta WHERE id = ?", [
        CLOCK_TOLERANCE_META_ID,
      ]),
    ).toEqual({ value: "5" });
  });

  it.each([
    ["a figure in the wrong unit", rate(5, "days")],
    ["a negative figure", rate(-1)],
    ["more than an hour", rate(90)],
    ["a fraction", rate(2.5)],
    ["words", rate("five")],
  ])("ignores %s", async (_case, fetch) => {
    const db = await metaStore();
    expect(await resolveClockTolerance(db, online(fetch))).toBe(FAIL_SAFE_TOLERANCE_MINUTES);
  });
});
