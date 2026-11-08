import { describe, expect, it } from "vitest";
import { builtinRole } from "./roles";

/**
 * The clinician's judgement on a death, police references and the mortality review are read only
 * with safety.death_detail.read (slice 83 guides review; HZ-011, HZ-013): never by agency workers,
 * care coordinators or care workers by default, who keep safety.incident.read.
 */
describe("hazard HZ-011 who reads a death record's sensitive detail by default", () => {
  it.each([
    ["owner", true],
    ["registered_manager", true],
    ["deputy_manager", true],
    ["clinical_lead", true],
    ["team_leader", true],
    ["quality_lead", true],
    ["care_worker", false],
    ["care_coordinator", false],
    ["agency_worker", false],
    ["family_representative", false],
  ])("%s holds it: %s", (key, holds) => {
    const role = builtinRole(key);
    expect(role, key).toBeDefined();
    expect(role?.permissions.includes("safety.death_detail.read")).toBe(holds);
  });

  it("leaves care coordinators and agency workers able to read incidents", () => {
    expect(builtinRole("care_coordinator")?.permissions).toContain("safety.incident.read");
    expect(builtinRole("agency_worker")?.permissions).toContain("safety.incident.read");
  });
});
