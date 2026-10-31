import { describe, expect, it } from "vitest";
import {
  offlineDaysFromToken,
  offlineWindowBounds,
  parseCachedOfflineDays,
  parseOfflineDays,
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
