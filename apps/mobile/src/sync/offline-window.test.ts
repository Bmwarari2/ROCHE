import { MAX_OFFLINE_WINDOW_DAYS } from "@harbour/sync/client";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/http";
import {
  chooseWindowDays,
  FAIL_SAFE_WINDOW_DAYS,
  fetchOfflineWindowDays,
  parseCachedWindowDays,
  resolveOfflineWindow,
  WINDOW_META_ID,
  windowStart,
} from "./offline-window";

describe("windowStart (refused content ages out from here, S7)", () => {
  it.each([
    ["2026-10-11T10:00:00Z", 1, "2026-10-11T00:00:00.000Z"],
    ["2026-10-11T10:00:00Z", 3, "2026-10-09T00:00:00.000Z"],
    ["2026-10-11T23:59:00Z", 7, "2026-10-05T00:00:00.000Z"],
  ])("at %s with %i days is %s", (now, days, expected) => {
    expect(windowStart(new Date(now), days)).toBe(expected);
  });
});

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";

function fetchReturning(response: Response | Error) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, calls };
}

const rate = (value: unknown, status = 200) =>
  new Response(
    JSON.stringify({ key: "mobile.offline_window_days", value, unit: "days", nation: "all" }),
    { status, headers: { "content-type": "application/json" } },
  );

/** Just enough of the PowerSync database for the sync_meta cache. */
function metaStore(initial: string | null) {
  const rows = new Map<string, string>(initial === null ? [] : [[WINDOW_META_ID, initial]]);
  return {
    rows,
    db: {
      getOptional: async (_sql: string, params?: unknown[]) => {
        const value = rows.get(String(params?.[0]));
        return value === undefined ? null : { value };
      },
      execute: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("DELETE")) rows.delete(String(params?.[0]));
        else rows.set(String(params?.[0]), String(params?.[2]));
        return { rowsAffected: 1 };
      },
    } as never,
  };
}

describe("fetchOfflineWindowDays (the figure comes from the rate table)", () => {
  it("reads mobile.offline_window_days for the signed-in tenant", async () => {
    const { fetch, calls } = fetchReturning(rate(7));
    await expect(
      fetchOfflineWindowDays({ apiUrl: API, fetch, token: "tok", tenantId: TENANT }),
    ).resolves.toBe(7);
    expect(calls[0]?.url).toBe(`${API}/v1/rates/mobile.offline_window_days`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-harbour-tenant")).toBe(TENANT);
    expect(headers.get("authorization")).toBe("Bearer tok");
  });

  it.each([
    ["a missing rate", rate(7, 404)],
    ["a fraction", rate(7.5)],
    ["zero", rate(0)],
    ["more than the service limit", rate(MAX_OFFLINE_WINDOW_DAYS + 1)],
    ["text", rate("7")],
    ["no network", new TypeError("Network request failed")],
  ])("gives no figure for %s", async (_label, response) => {
    const { fetch } = fetchReturning(response);
    await expect(
      fetchOfflineWindowDays({ apiUrl: API, fetch, token: "tok", tenantId: TENANT }),
    ).resolves.toBeNull();
  });
});

describe("choosing the window", () => {
  it.each([
    [7, 3, 7],
    [null, 14, 14],
    [null, null, FAIL_SAFE_WINDOW_DAYS],
  ])("fetched %s, cached %s -> %s days", (fetched, cached, expected) => {
    expect(chooseWindowDays(fetched, cached)).toBe(expected);
  });

  it.each([
    ["7", 7],
    ["", null],
    [null, null],
    ["seven", null],
    ["0", null],
  ])("reads the cached value %j as %s", (value, expected) => {
    expect(parseCachedWindowDays(value)).toBe(expected);
  });
});

describe("resolveOfflineWindow (what the device says it keeps, HZ-028)", () => {
  it("caches a new figure", async () => {
    const { fetch } = fetchReturning(rate(3));
    const store = metaStore("7");
    const result = await resolveOfflineWindow(store.db, {
      apiUrl: API,
      fetch,
      token: "tok",
      tenantId: TENANT,
    });
    expect(result).toEqual({ days: 3 });
    expect(store.rows.get(WINDOW_META_ID)).toBe("3");
  });

  it("uses the cached figure when offline", async () => {
    const { fetch } = fetchReturning(new TypeError("Network request failed"));
    const store = metaStore("2");
    const result = await resolveOfflineWindow(store.db, {
      apiUrl: API,
      fetch,
      token: "tok",
      tenantId: TENANT,
    });
    expect(result).toEqual({ days: 2 });
  });

  it("reports today only until the tenant's figure has been read", async () => {
    const result = await resolveOfflineWindow(metaStore(null).db, null);
    expect(result).toEqual({ days: FAIL_SAFE_WINDOW_DAYS });
  });
});
