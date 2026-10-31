import { describe, expect, it } from "vitest";
import {
  commitOfflineDays,
  OFFLINE_DAYS_META_ID,
  offlineDaysFromToken,
  offlineWindowBounds,
  parseCachedOfflineDays,
  parseOfflineDays,
  windowToCommit,
} from "./offline-days";

const token = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("hazard HZ-028 the offline window's days as the token gave them (#123 clinical review, M4)", () => {
  it("reads the token's UTC days, sorted, without duplicates", () => {
    expect(
      offlineDaysFromToken(token({ offline_days: ["2026-10-21", "2026-10-20", "2026-10-20"] })),
    ).toEqual(["2026-10-20", "2026-10-21"]);
  });

  it.each([
    ["no days", { sub: "u" }],
    ["an empty list", { offline_days: [] }],
    ["not days", { offline_days: ["tomorrow", 3] }],
  ])("reads %s as none, so the phone says it does not know", (_label, claims) => {
    expect(offlineDaysFromToken(token(claims))).toBeNull();
  });

  it("covers whole UTC days, the last one up to the next UTC midnight", () => {
    expect(offlineWindowBounds(["2026-10-20", "2026-10-21"])).toEqual({
      start: new Date("2026-10-20T00:00:00Z"),
      end: new Date("2026-10-22T00:00:00Z"),
    });
    expect(offlineWindowBounds([])).toBeNull();
  });

  it("reads a damaged copy kept on the phone as none", () => {
    expect(parseCachedOfflineDays("{")).toBeNull();
    expect(parseCachedOfflineDays(JSON.stringify(["2026-10-20"]))).toEqual(["2026-10-20"]);
    expect(parseOfflineDays("2026-10-20")).toBeNull();
  });
});

describe("hazard HZ-028 the window is the one the last successful sync used (#123 clinical review re-check, M2)", () => {
  const pending = { days: ["2026-10-21", "2026-10-22"], fetchedAt: 1_000 };

  it("records a token's days only once a sync that finished after it was fetched completes", () => {
    // The token arrived, but no sync with it has completed: the previous window stays.
    expect(windowToCommit(pending, null)).toBeNull();
    expect(windowToCommit(pending, 999)).toBeNull();
    // A sync completed after the token was fetched: that window is what the phone holds.
    expect(windowToCommit(pending, 1_000)).toEqual(pending.days);
    expect(windowToCommit(null, 5_000)).toBeNull();
  });

  it("removes the old window when the new one cannot be kept, so the round says it cannot tell", async () => {
    const rows = new Map<string, string>([[OFFLINE_DAYS_META_ID, '["2026-10-20"]']]);
    const db = {
      async execute(sql: string, params?: unknown[]) {
        if (sql.startsWith("INSERT")) throw new Error("disk full");
        if (sql.startsWith("DELETE")) rows.delete(String(params?.[0]));
      },
    };
    expect(await commitOfflineDays(db, pending.days)).toBe(false);
    expect(rows.has(OFFLINE_DAYS_META_ID)).toBe(false);
  });

  it("keeps the new window when it can", async () => {
    const rows = new Map<string, string>();
    const db = {
      async execute(sql: string, params?: unknown[]) {
        if (sql.startsWith("DELETE")) rows.delete(String(params?.[0]));
        else rows.set(String(params?.[0]), String(params?.[2]));
      },
    };
    expect(await commitOfflineDays(db, pending.days)).toBe(true);
    expect(JSON.parse(rows.get(OFFLINE_DAYS_META_ID) ?? "null")).toEqual(pending.days);
  });
});
