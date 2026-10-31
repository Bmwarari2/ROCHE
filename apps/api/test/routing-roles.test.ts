import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinRole } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { SAFEGUARDING_CONCERN_ROLE } from "../src/routes/agency";
import { WORKING_TIME_FINDING_ROLE } from "../src/routes/time-attendance";
import { REVIEW_TASKS } from "../src/services/care-planning";
import {
  DEVELOPMENT_REMINDER_PERMISSION,
  DEVELOPMENT_REMINDER_ROLE,
} from "../src/services/development";
import { DISCARD_OTHERS_PERMISSION } from "../src/services/device-holds";
import { COMPLIANCE_EXPIRY_ROLE, STAFF_FILE_MANAGE } from "../src/services/staff-files";
import { RECORD_READ_PERMISSION } from "../src/services/staff-views";
import { OVERDUE_FIRST_RESPONDERS } from "../src/services/tasks";
import { CLOCK_EXCEPTION_ROLE } from "../src/services/time-attendance";

/**
 * Hazard HZ-073 (ADR-0071 review round 1, C-M3): safety work routed by role must reach someone
 * who can both see it and act on it. Every role key the services route work to by name holds
 * `people.person.read` (a task or alert about a person is opened with it) and the work's own
 * permission in its built-in bundle, at the same scope (a built-in bundle has one scope kind, so
 * holding both in one bundle means holding both at the same place). An organisation that edits a
 * built-in bundle or routes to its own roles is covered by the deployer control in HZ-011 and
 * HZ-073 (review role bundles before go-live) and, at run time, by the routing itself, which
 * skips anyone who cannot see the person.
 */

const SERVICES = fileURLToPath(new URL("../src/services", import.meta.url));
const REGISTERED_MANAGER = "registered_manager";

/** Permissions the task inserts name by identifier rather than literally. */
const NAMED: Readonly<Record<string, readonly string[]>> = {
  REVIEW_PERMISSION: ["care.plan.write"],
  DISCARD_OTHERS_PERMISSION: [DISCARD_OTHERS_PERMISSION],
  "spec.permission": Object.values(REVIEW_TASKS).map((t) => t.permission),
};

/**
 * Every `assigneeRoleKey: "<key>"` in the services, with the `requiredPermission` of the same
 * task (the nearest one before it, within 20 lines). A regex scan: an insert written another way
 * (a variable holding the role key, a permission computed elsewhere) is not seen, and an
 * identifier not in `NAMED` fails the test so a new kind of site is looked at.
 */
function assigneeRoleSites(): { file: string; roleKey: string; permissions: readonly string[] }[] {
  const sites: { file: string; roleKey: string; permissions: readonly string[] }[] = [];
  for (const file of readdirSync(SERVICES).filter((f) => f.endsWith(".ts"))) {
    const lines = readFileSync(join(SERVICES, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const role = /assigneeRoleKey:\s*"(\w+)"/.exec(line);
      if (!role?.[1]) return;
      const window = lines.slice(Math.max(0, i - 20), i).reverse();
      const required = window
        .map((l) => /requiredPermission:\s*([^,]+),/.exec(l)?.[1]?.trim())
        .find((v) => v !== undefined);
      if (required === undefined) throw new Error(`${file}:${i + 1} names no permission`);
      const literal = /^"([a-z_.]+)"$/.exec(required)?.[1];
      const permissions = literal ? [literal] : NAMED[required];
      if (!permissions) throw new Error(`${file}:${i + 1}: unknown permission ${required}`);
      sites.push({ file: `${file}:${i + 1}`, roleKey: role[1], permissions });
    });
  }
  return sites;
}

function bundle(roleKey: string): readonly string[] {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(`${roleKey} is not a built-in role`);
  return role.permissions;
}

describe("hazard HZ-073 routed safety work reaches someone who can see it and act on it (ADR-0071 review round 1, C-M3)", () => {
  const sites = assigneeRoleSites();

  it("finds the services' role-routed tasks", () => {
    expect(sites.length).toBeGreaterThanOrEqual(12);
    expect(new Set(sites.map((s) => s.roleKey))).toEqual(
      // The owner receives the organisation's data security renewals (quality.md rule 36).
      new Set(["clinical_lead", REGISTERED_MANAGER, "owner"]),
    );
  });

  it.each(
    assigneeRoleSites().flatMap((s) => s.permissions.map((permission) => ({ ...s, permission }))),
  )("$roleKey holds people.person.read and $permission ($file)", ({ roleKey, permission }) => {
    expect(bundle(roleKey)).toContain(RECORD_READ_PERMISSION);
    expect(bundle(roleKey)).toContain(permission);
  });

  it.each([...OVERDUE_FIRST_RESPONDERS, REGISTERED_MANAGER])(
    "%s, told first about overdue tasks, urgent results and reviews, can open the person",
    (roleKey) => {
      expect(bundle(roleKey)).toContain(RECORD_READ_PERMISSION);
    },
  );

  it.each([DISCARD_OTHERS_PERMISSION, "care.plan.write"])(
    "the Registered Manager fallbacks hold people.person.read and %s",
    (permission) => {
      expect(bundle(REGISTERED_MANAGER)).toContain(RECORD_READ_PERMISSION);
      expect(bundle(REGISTERED_MANAGER)).toContain(permission);
    },
  );

  it.each([
    ...new Set([...Object.values(REVIEW_TASKS).map((t) => t.permission), "care.plan.write"]),
  ])(
    "the nurse in charge told about a review needing %s includes a role that holds it",
    (permission) => {
      // A senior carer in charge who lacks it is told of the review but cannot do it; the review
      // task is assigned to the clinical lead, and a refused entry's urgent review is told only to
      // those who hold it (services/refused-entries.ts).
      const holders = OVERDUE_FIRST_RESPONDERS.filter(
        (key) => bundle(key).includes(permission) && bundle(key).includes(RECORD_READ_PERMISSION),
      );
      expect(holders).toContain("clinical_lead");
    },
  );
});

describe("workforce reminders reach a role that can act on them (workforce.md section 5)", () => {
  // These tasks are about no person and no location: the role needs the task's own permission,
  // which also makes the task visible to it (migration 0079), not people.person.read.
  it.each([
    [COMPLIANCE_EXPIRY_ROLE, STAFF_FILE_MANAGE],
    [DEVELOPMENT_REMINDER_ROLE, DEVELOPMENT_REMINDER_PERMISSION],
  ])("%s holds %s", (roleKey, permission) => {
    expect(bundle(roleKey)).toContain(permission);
  });
});

describe("a safeguarding concern about a bank or agency worker reaches a role that can act", () => {
  it("the role told holds safety.incident.report", () => {
    expect(bundle(SAFEGUARDING_CONCERN_ROLE)).toContain("safety.incident.report");
  });
});

describe("time and attendance tasks reach a role that can act (scheduling.md section 16)", () => {
  it.each([
    [CLOCK_EXCEPTION_ROLE, "scheduling.rota.approve"],
    [WORKING_TIME_FINDING_ROLE, "scheduling.rota.approve"],
  ])("%s holds %s", (roleKey, permission) => {
    expect(bundle(roleKey)).toContain(permission);
  });
});
