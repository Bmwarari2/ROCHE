import { describe, expect, it } from "vitest";
import {
  HANDOVER_SHIFTS_META_ID,
  handoverConfigFromToken,
  parseHandoverShifts,
  readCachedHandoverConfig,
  writeCachedHandoverConfig,
} from "./handover-shifts";

/** A token whose payload carries these claims (the phone never verifies the signature). */
function token(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.signature`;
}

describe("hazard HZ-018 each nation's shift pattern and the handover reach from the sync token (gate item (e), ADR-0074)", () => {
  it("reads the nations and where the handover reaches from the token", () => {
    expect(
      handoverConfigFromToken(
        token({
          handover_shifts: { england: { day: 480, night: 1200 } },
          handover_location_ids: ["loc-north"],
          handover_assigned: false,
        }),
      ),
    ).toEqual({
      shifts: { england: { day: 480, night: 1200 } },
      locationIds: ["loc-north"],
      assigned: false,
    });
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

  it.each<[string, unknown, Record<string, unknown>]>([
    ["a lead in minutes", 60, { day: 480, night: 1200, lead: 60 }],
    ["no lead", undefined, { day: 480, night: 1200 }],
    ["a lead that is not whole minutes", 60.5, { day: 480, night: 1200 }],
    ["a negative lead", -5, { day: 480, night: 1200 }],
    ["a lead as text", "60", { day: 480, night: 1200 }],
  ])(
    "hazard HZ-018 reads the preview lead from the token with %s (H-420)",
    (_label, lead, figures) => {
      expect(parseHandoverShifts({ england: { day: 480, night: 1200, lead } })).toEqual({
        england: figures,
      });
    },
  );

  it("keeps the readable nations beside an unreadable one", () => {
    expect(parseHandoverShifts({ england: { day: 480, night: 1200 }, wales: null })).toEqual({
      england: { day: 480, night: 1200 },
    });
  });

  it("reads no reach when the handover family does not reach the phone, or the token cannot be read", () => {
    expect(handoverConfigFromToken(token({ sub: "u" }))).toBeNull();
    expect(handoverConfigFromToken("not-a-token")).toBeNull();
    expect(
      handoverConfigFromToken(token({ handover_location_ids: [], handover_assigned: false })),
    ).toBeNull();
    // Reached by assignment alone, with a pattern it cannot read: no nations, so it cannot tell.
    expect(
      handoverConfigFromToken(token({ handover_assigned: true, handover_shifts: [1, 2] })),
    ).toEqual({ shifts: {}, locationIds: [], assigned: true });
  });

  it("keeps the last copy on the phone, clears it when the reach ends, and reads a damaged one as none", async () => {
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
    expect(await readCachedHandoverConfig(db)).toBeNull();
    const config = {
      shifts: { wales: { day: 450, night: 1170 } },
      locationIds: ["l"],
      assigned: false,
    };
    await writeCachedHandoverConfig(db, config);
    expect(await readCachedHandoverConfig(db)).toEqual(config);
    await writeCachedHandoverConfig(db, null);
    expect(await readCachedHandoverConfig(db)).toBeNull();
    rows.set(HANDOVER_SHIFTS_META_ID, "{not json");
    expect(await readCachedHandoverConfig(db)).toBeNull();
  });
});
