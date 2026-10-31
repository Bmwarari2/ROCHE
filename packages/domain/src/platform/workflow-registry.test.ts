import { describe, expect, it } from "vitest";
import { requiresStepUp } from "./permissions";
import { LISTED_WORKFLOW_PERMISSIONS, LISTED_WORKFLOWS, listedWorkflow } from "./workflow-registry";

describe("the workflows the approvals screen lists (PLAT-011)", () => {
  it("lists each workflow once, found by its key", () => {
    const keys = LISTED_WORKFLOWS.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(listedWorkflow(key)?.key).toBe(key);
    expect(listedWorkflow("people.person_lifecycle")).toBeUndefined();
    expect(listedWorkflow("not.a.workflow")).toBeUndefined();
  });

  it("has the closing of an incident as an approval the raiser may not take", () => {
    const incident = listedWorkflow("safety.incident");
    expect(incident?.transitions.some((t) => t.to === "closed" && t.distinctFromCreator)).toBe(
      true,
    );
  });

  it("puts step-up permissions after the others", () => {
    const flags = LISTED_WORKFLOW_PERMISSIONS.map((p) => requiresStepUp(p));
    expect(flags).toEqual([...flags].sort((a, b) => Number(a) - Number(b)));
    expect(LISTED_WORKFLOW_PERMISSIONS).toContain("safety.incident.manage");
    expect(new Set(LISTED_WORKFLOW_PERMISSIONS).size).toBe(LISTED_WORKFLOW_PERMISSIONS.length);
  });
});
