import { describe, expect, it } from "vitest";
import {
  HANDOVER_SHIFTS_META_ID,
  handoverShiftsFromToken,
  parseHandoverShifts,
  readCachedHandoverShifts,
  writeCachedHandoverShifts,
} from "./handover-shifts";

/** A token whose payload carries these claims (the phone never verifies the signature). */
function token(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

describe("hazard HZ-018 each nation's shift pattern from the sync token (gate item (e), ADR-0074)", () => {
  it("reads the nations the token carries", () => {
    expect(
      handoverShiftsFromToken(token({ handover_shifts: { england: { day: 480, night: 1200 } } })),
    ).toEqual({ england: { day: 480, night: 1200 } });
  });

  it.each([
    ["missing figures", { england: { day: 480 } }],
    ["out of range", { england: { day: 480, night: 1440 } }],
    ["not whole minutes", { england: { day: 480.5, night: 1200 } }],
    ["equal starts", { england: { day: 480, night: 480 } }],
    ["text", { england: { day: "480", night: "1200" } }],
  ])("leaves out a nation with %s, so the phone says it cannot tell", (_label, value) => {
    expect(parseHandoverShifts(value)).toEqual({});
  });

  it("keeps the readable nations beside an unreadable one", () => {
    expect(parseHandoverShifts({ england: { day: 480, night: 1200 }, wales: null })).toEqual({
      england: { day: 480, night: 1200 },
    });
  });

  it("changes nothing when the token has no pattern or cannot be read", () => {
    expect(handoverShiftsFromToken(token({ sub: "u" }))).toBeNull();
    expect(handoverShiftsFromToken("not-a-token")).toBeNull();
    expect(handoverShiftsFromToken(token({ handover_shifts: [1, 2] }))).toBeNull();
  });

  it("keeps the last pattern on the phone, and reads a damaged one as none", async () => {
    const rows = new Map<string, string>();
    const db = {
      async getOptional<T>(_sql: string, params?: unknown[]) {
        const value = rows.get(String(params?.[0]));
        return (value === undefined ? null : { value }) as T | null;
      },
      async execute(sql: string, params?: unknown[]) {
        if (sql.startsWith("DELETE")) rows.delete(String(params?.[0]));
        else rows.set(String(params?.[0]), String(params?.[2]));
      },
    };
    expect(await readCachedHandoverShifts(db)).toBeNull();
    await writeCachedHandoverShifts(db, { wales: { day: 450, night: 1170 } });
    expect(await readCachedHandoverShifts(db)).toEqual({ wales: { day: 450, night: 1170 } });
    rows.set(HANDOVER_SHIFTS_META_ID, "{not json");
    expect(await readCachedHandoverShifts(db)).toBeNull();
  });
});
