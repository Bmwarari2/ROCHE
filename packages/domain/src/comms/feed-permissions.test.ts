import { describe, expect, it } from "vitest";
import { type Permission, touchesCareRecords } from "../platform/permissions";
import { BUILTIN_ROLES, builtinRole, PORTAL_ONLY_PERMISSIONS } from "../platform/roles";

/** The comms permissions (comms.md section 3): who holds them, and which need MFA. */

const COMMS: readonly Permission[] = [
  "comms.feed.read",
  "comms.feed.publish",
  "comms.feed.withdraw",
  "comms.notification.subscribe",
  "comms.notification.manage",
  "comms.visit_booking.request",
  "comms.visit_booking.manage",
];

const holders = (permission: Permission) =>
  BUILTIN_ROLES.filter((r) => r.permissions.includes(permission))
    .map((r) => r.key)
    .sort();

describe("comms permissions by role", () => {
  it.each<[Permission, readonly string[]]>([
    ["comms.feed.read", ["family_representative"]],
    ["comms.notification.subscribe", ["family_representative"]],
    ["comms.visit_booking.request", ["family_representative"]],
    [
      "comms.feed.publish",
      ["clinical_lead", "deputy_manager", "owner", "registered_manager", "team_leader"],
    ],
    [
      "comms.feed.withdraw",
      ["clinical_lead", "deputy_manager", "owner", "registered_manager", "team_leader"],
    ],
    [
      "comms.notification.manage",
      ["administrator", "deputy_manager", "owner", "registered_manager"],
    ],
    [
      "comms.visit_booking.manage",
      ["administrator", "deputy_manager", "owner", "registered_manager"],
    ],
  ])("%s is held by %j", (permission, roles) => {
    expect(holders(permission)).toEqual([...roles].sort());
  });

  it("hazard HZ-022 never gives a member of staff a portal-only permission", () => {
    for (const role of BUILTIN_ROLES) {
      if (role.key === "family_representative" || role.key === "person_receiving_care") continue;
      for (const p of PORTAL_ONLY_PERMISSIONS) expect(role.permissions).not.toContain(p);
    }
  });

  it("hazard HZ-022 asks for MFA wherever the feed or its sources are read or published", () => {
    expect(COMMS.filter(touchesCareRecords)).toEqual([
      "comms.feed.read",
      "comms.feed.publish",
      "comms.feed.withdraw",
    ]);
    expect(builtinRole("family_representative")?.permissions.some(touchesCareRecords)).toBe(true);
  });

  it("leaves care workers and agency staff out of publishing to families", () => {
    for (const key of ["care_worker", "agency_worker"]) {
      expect(builtinRole(key)?.permissions).not.toContain("comms.feed.publish");
    }
  });
});
