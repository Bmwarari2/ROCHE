import { describe, expect, it } from "vitest";
import {
  devicesShown,
  groupDevices,
  isWithdrawReason,
  mayWithdrawDevices,
  namesInWords,
} from "./care-devices";

/** Invented device and member ids, and invented staff. */
const PHONE = "0199d000-0000-4000-8000-0000000babcd";
const OTHER = "0199d000-0000-4000-8000-0000000b1234";
const ADA = "0199d000-0000-7000-8000-000000000a01";
const BEN = "0199d000-0000-7000-8000-000000000b01";

const binding = (overrides: Record<string, unknown> = {}) => ({
  deviceId: PHONE,
  tenantUserId: ADA,
  memberName: "Ada Example",
  firstSeenAt: "2026-11-01T08:00:00Z",
  lastSeenAt: "2026-11-07T08:00:00Z",
  revokedAt: null,
  revokedBy: null,
  revocationReason: null,
  entriesWaiting: 0,
  lastReportedAt: null,
  ...overrides,
});

describe("hazard HZ-040 Care mode phones grouped for a manager", () => {
  it("groups bindings by phone, with everyone who used it, the earliest and latest times", () => {
    const [phone, other] = groupDevices([
      binding({ entriesWaiting: 3, lastReportedAt: "2026-11-07T09:00:00Z" }),
      binding({
        tenantUserId: BEN,
        memberName: "Ben Example",
        firstSeenAt: "2026-10-30T08:00:00Z",
        lastSeenAt: "2026-11-08T08:00:00Z",
        entriesWaiting: 3,
        lastReportedAt: "2026-11-07T09:00:00Z",
      }),
      binding({ deviceId: OTHER, lastSeenAt: "2026-11-02T08:00:00Z" }),
    ]);
    expect(phone).toMatchObject({
      deviceId: PHONE,
      shortId: "ABCD",
      firstSeenAt: "2026-10-30T08:00:00Z",
      lastSeenAt: "2026-11-08T08:00:00Z",
      entriesWaiting: 3,
      revokedAt: null,
    });
    expect(phone?.members.map((m) => m.name)).toEqual(["Ada Example", "Ben Example"]);
    expect(other?.deviceId).toBe(OTHER);
  });

  it("counts a phone withdrawn only when every binding is", () => {
    const revoked = { revokedAt: "2026-11-08T10:00:00Z", revocationReason: "lost_or_stolen" };
    const ben = { tenantUserId: BEN, memberName: "Ben Example" };
    const [partly] = groupDevices([binding(), binding({ ...ben, ...revoked })]);
    expect(partly?.revokedAt).toBeNull();
    const [phone] = groupDevices([binding(revoked), binding({ ...ben, ...revoked })]);
    expect(phone).toMatchObject(revoked);
  });

  it.each([
    [["platform.device.read"], true, false],
    [["platform.device.read", "platform.device.revoke"], true, true],
    [[], false, false],
  ])("permissions %j: shown %s, may withdraw %s", (permissions, shown, withdraw) => {
    expect(devicesShown(permissions)).toBe(shown);
    expect(mayWithdrawDevices(permissions)).toBe(withdraw);
  });

  it.each([
    ["lost_or_stolen", true],
    ["other", true],
    ["because", false],
    [null, false],
  ])("reason %j is a code the API takes: %s", (value, ok) => {
    expect(isWithdrawReason(value)).toBe(ok);
  });

  it("never names two phones the same", () => {
    const a = "0199d000-0000-4000-8000-00000011abcd";
    const b = "0199d000-0000-4000-8000-00000022abcd";
    const [first, second] = groupDevices([binding({ deviceId: a }), binding({ deviceId: b })]);
    expect(first?.shortId).not.toBe(second?.shortId);
    expect(first?.shortId).toMatch(/ABCD$/);
  });

  it("says the names as a list in words", () => {
    expect(namesInWords(["Ada Example"])).toBe("Ada Example");
    expect(namesInWords(["Ada Example", "Ben Example"])).toBe("Ada Example and Ben Example");
  });
});
