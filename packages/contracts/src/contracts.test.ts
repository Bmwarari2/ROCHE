import { describe, expect, it } from "vitest";
import { BreakGlassRequest, PersonSummary, ProblemDetails, SyncUpload } from "./index";

describe("contracts", () => {
  it("parses a point-of-care person summary", () => {
    const parsed = PersonSummary.parse({
      id: "0193a000-0000-7000-8000-000000000401",
      locationId: "0193a000-0000-7000-8000-000000000101",
      status: "active",
      givenName: "Ada",
      familyName: "Example",
      preferredName: null,
      dateOfBirth: "1938-02-01",
      nhsNumber: "9990000018",
      roomLabel: "4",
      photoUrl: null,
      allergyStatus: "has_allergies",
      allergies: [{ substance: "Penicillin", severity: "severe", reaction: null }],
      communicationNeeds: [{ code: "fixture-large-print", display: "Requires large print" }],
      version: 1,
    });
    expect(parsed.allergies).toHaveLength(1);
  });

  it("requires a meaningful break-glass justification", () => {
    const result = BreakGlassRequest.safeParse({
      personId: "0193a000-0000-7000-8000-000000000401",
      justification: "need it",
    });
    expect(result.success).toBe(false);
  });

  it("caps sync upload batches", () => {
    const op = { op: "PUT", table: "care_note", id: "x" };
    expect(SyncUpload.safeParse({ operations: Array(501).fill(op) }).success).toBe(false);
    expect(SyncUpload.safeParse({ operations: [op] }).success).toBe(true);
  });

  it("defaults problem type to about:blank", () => {
    expect(
      ProblemDetails.parse({ title: "Forbidden", status: 403, code: "missing_permission" }).type,
    ).toBe("about:blank");
  });
});
