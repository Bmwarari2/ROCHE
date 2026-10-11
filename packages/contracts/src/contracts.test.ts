import { describe, expect, it } from "vitest";
import {
  BreakGlassRequest,
  CreateAssessment,
  PersonSummary,
  ProblemDetails,
  PublishCarePlan,
  ResuscitationStatus,
  SyncDeviceReport,
  SyncDiscard,
  SyncUpload,
  UpdateCarePlanSection,
} from "./index";

const NOT_RECORDED = {
  status: "not_recorded",
  conflicting: false,
  recordId: null,
  kind: null,
  completedOn: null,
  clinicianName: null,
  clinicianRole: null,
  reviewDueOn: null,
  reviewOverdue: false,
} as const;

const ADA = {
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
  resuscitation: NOT_RECORDED,
  version: 1,
} as const;

describe("contracts", () => {
  it("parses a point-of-care person summary", () => {
    expect(PersonSummary.parse(ADA).allergies).toHaveLength(1);
  });

  it("hazard HZ-015 needs a resuscitation status on every point-of-care summary", () => {
    const { resuscitation: _omitted, ...withoutStatus } = ADA;
    expect(PersonSummary.safeParse(withoutStatus).success).toBe(false);
    expect(
      PersonSummary.safeParse({ ...ADA, resuscitation: { ...NOT_RECORDED, status: "" } }).success,
    ).toBe(false);
    expect(ResuscitationStatus.parse(NOT_RECORDED).status).toBe("not_recorded");
  });

  it("uses inclusive bounds only on care planning numbers", () => {
    expect(PublishCarePlan.shape.version.safeParse(0).success).toBe(false);
    expect(PublishCarePlan.shape.version.safeParse(1).success).toBe(true);
    expect(UpdateCarePlanSection.shape.version.safeParse(0).success).toBe(true);
  });

  it("tells the validated tools apart by key", () => {
    const braden = CreateAssessment.safeParse({
      toolKey: "braden",
      occurredAt: "2026-10-11T10:00:00+01:00",
      answers: {
        sensoryPerception: 3,
        moisture: 3,
        activity: 2,
        mobility: 2,
        nutrition: 3,
        frictionAndShear: 2,
      },
    });
    expect(braden.success).toBe(true);
    expect(
      CreateAssessment.safeParse({
        toolKey: "news2",
        occurredAt: "2026-10-11T10:00:00Z",
        answers: {},
      }).success,
    ).toBe(false);
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

describe("hazard HZ-040 device discards and reports", () => {
  const discard = {
    id: "0199d000-0000-7000-8000-0000000000d1",
    kind: "held_deleted",
    reasonCode: "recorded_elsewhere",
    ownerTenantUserId: "00000000-0000-4000-8000-0000000000c1",
    entryIds: ["0199d000-0000-7000-8000-0000000000e1"],
    personIds: ["00000000-0000-4000-8000-0000000000b1"],
    count: 1,
    discardedAt: "2026-10-11T07:30:00.000Z",
  };

  it("accepts a coded reason, with free text only as an option", () => {
    expect(SyncDiscard.safeParse(discard).success).toBe(true);
    expect(SyncDiscard.safeParse({ ...discard, reason: "On paper" }).success).toBe(true);
  });

  it("needs the reason in words when the code is other", () => {
    expect(SyncDiscard.safeParse({ ...discard, reasonCode: "other" }).success).toBe(false);
    expect(
      SyncDiscard.safeParse({ ...discard, reasonCode: "other", reason: "Duplicate device" })
        .success,
    ).toBe(true);
  });

  it.each([
    ["an unknown kind", { kind: "anything" }],
    ["an unknown reason code", { reasonCode: "because" }],
    ["entry ids that are not ids", { entryIds: ["Ada's note"] }],
    ["a deleter that is not an id", { deletedByTenantUserId: "Mo Manager" }],
    ["a reason over 500 characters", { reason: "x".repeat(501) }],
  ])("refuses %s", (_case, change) => {
    expect(SyncDiscard.safeParse({ ...discard, ...change }).success).toBe(false);
  });

  it("carries counts and an age only in a device report", () => {
    const report = {
      unsent: 3,
      refused: 1,
      held: 0,
      oldestAgeSeconds: 3600,
      reportedAt: "2026-10-11T07:30:00.000Z",
    };
    expect(SyncDeviceReport.safeParse(report).success).toBe(true);
    expect(SyncDeviceReport.safeParse({ ...report, unsent: -1 }).success).toBe(false);
    expect(Object.keys(SyncDeviceReport.parse({ ...report, name: "Ada" }))).not.toContain("name");
  });
});
