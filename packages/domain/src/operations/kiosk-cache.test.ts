import { describe, expect, it } from "vitest";
import { tableRetentionRule } from "../../test/rate-table";
import { builtinRole } from "../platform/roles";
import {
  kioskDowntimeCacheDisposition,
  kioskDowntimePackUnlock,
  kioskPrintAuditEvent,
} from "./kiosk-cache";

/** The downtime pack cached on a kiosk (operations.md rule 8; kiosk.md 3.5). Hazard HZ-021. */

const permissionsOf = (role: string) => new Set(builtinRole(role)?.permissions ?? []);

describe("hazard HZ-021 the kiosk opens its cached pack only in a PIN session of a downtime reader", () => {
  it.each<[string, Parameters<typeof kioskDowntimePackUnlock>[0], boolean, string | null]>([
    [
      "a team leader signed in with their PIN",
      { userId: "u1", pinVerified: true, permissions: permissionsOf("team_leader") },
      false,
      null,
    ],
    [
      "a care worker signed in with their PIN",
      { userId: "u2", pinVerified: true, permissions: permissionsOf("care_worker") },
      false,
      "missing_permission",
    ],
    [
      "a team leader without a PIN session",
      { userId: "u1", pinVerified: false, permissions: permissionsOf("team_leader") },
      false,
      "pin_session_required",
    ],
    ["nobody signed in", null, false, "pin_session_required"],
    [
      "a revoked device, whoever signs in",
      { userId: "u1", pinVerified: true, permissions: permissionsOf("registered_manager") },
      true,
      "device_revoked",
    ],
  ])("hazard HZ-021 %s", (_label, session, keyRevoked, reason) => {
    const unlock = kioskDowntimePackUnlock(session, { keyRevoked });
    expect(unlock.ok ? null : unlock.reason).toBe(reason);
  });
});

describe("hazard HZ-021 the kiosk evicts its cached pack on revocation and at the end of retention", () => {
  const retention = tableRetentionRule("downtime_pack");
  const generatedAt = new Date("2026-10-11T00:05:00Z");

  it("reads a positive retention period from the schedule", () => {
    expect(retention.period).toBeGreaterThan(0);
  });

  it.each<[string, boolean, Date, string]>([
    ["a current pack", false, new Date("2026-10-12T00:00:00Z"), "keep"],
    ["a pack on a revoked device", true, new Date("2026-10-12T00:00:00Z"), "evict_device_revoked"],
    ["a pack past its retention", false, new Date("2027-10-11T00:05:00Z"), "evict_retention_ended"],
  ])("%s", (_label, keyRevoked, now, expected) => {
    expect(kioskDowntimeCacheDisposition({ generatedAt }, { keyRevoked }, retention, now)).toBe(
      expected,
    );
  });
});

describe("hazard HZ-021 the kiosk queues an audit event for every print and open", () => {
  it.each([
    ["printed", "operations.downtime_pack.printed"],
    ["opened", "operations.downtime_pack.opened"],
  ] as const)("queues an audit event with ids only when the pack is %s", (kind, action) => {
    const event = kioskPrintAuditEvent({
      kind,
      packId: "dp-1",
      userId: "u1",
      deviceId: "device-1",
      occurredAt: new Date("2026-10-11T15:00:00Z"),
      eventId: "evt-1",
    });
    expect(event).toEqual({
      action,
      packId: "dp-1",
      userId: "u1",
      deviceId: "device-1",
      occurredAt: new Date("2026-10-11T15:00:00Z"),
      idempotencyKey: "evt-1",
    });
  });
});
