import { CreateBodyMapMark } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { CARE_ENTRY_PATHS, isCareEntryTable, toCareUpload } from "./care-upload";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const PERSON = "00000000-0000-4000-8000-0000000000b1";
const ID = "0199d000-0000-7000-8000-000000000001";

const base = {
  tenant_id: TENANT,
  person_id: PERSON,
  location_id: "loc",
  occurred_at: "2026-10-11T08:55:00.000Z",
  device_time: "2026-10-11T09:00:00.000Z",
  recorded_at: null,
  late_entry: 0,
  clock_drift: 0,
  supersedes_id: null,
  correction_reason: null,
};

describe("isCareEntryTable", () => {
  it.each([
    ["care_note", true],
    ["observation", true],
    ["body_map_mark", true],
    ["activity_record", true],
    ["visit_log", true],
    ["care_plan", false],
    ["assessment", false],
    ["person", false],
  ])("%s -> %s", (table, expected) => {
    expect(isCareEntryTable(table)).toBe(expected);
  });

  it("has an endpoint for every writable table", () => {
    expect(Object.keys(CARE_ENTRY_PATHS).sort()).toEqual([
      "activity_record",
      "body_map_mark",
      "care_note",
      "observation",
      "visit_log",
    ]);
  });
});

describe("toCareUpload", () => {
  it("hazard HZ-017 sends a correction with the entry it supersedes and the reason", () => {
    const request = toCareUpload({
      op: "PUT",
      table: "care_note",
      id: ID,
      opData: {
        ...base,
        category: "health",
        body: "Corrected text",
        tags: "[]",
        supersedes_id: "0199c000-0000-7000-8000-000000000009",
        correction_reason: "Wrong person's name in the first note",
      },
    });
    expect(request).toMatchObject({
      kind: "request",
      path: `/v1/people/${PERSON}/notes`,
      body: {
        id: ID,
        supersedesId: "0199c000-0000-7000-8000-000000000009",
        correctionReason: "Wrong person's name in the first note",
      },
    });
  });

  it("hazard HZ-029 sends the round's task the entry is the evidence for, so the API completes it", () => {
    const request = toCareUpload({
      op: "PUT",
      table: "observation",
      id: ID,
      opData: {
        ...base,
        chart: "repositioning",
        chart_values: '{"chart":"repositioning","position":"left"}',
        task_id: "0199c000-0000-7000-8000-0000000000a1",
      },
    });
    expect(request).toMatchObject({
      kind: "request",
      body: { id: ID, taskId: "0199c000-0000-7000-8000-0000000000a1" },
    });
  });

  it("leaves out empty optional fields, which the API refuses as null", () => {
    const request = toCareUpload({
      op: "PUT",
      table: "care_note",
      id: ID,
      opData: { ...base, category: "night", body: "Slept well", tags: null },
    });
    expect(request.kind === "request" && request.body).toEqual({
      id: ID,
      occurredAt: base.occurred_at,
      deviceTime: base.device_time,
      category: "night",
      body: "Slept well",
      tags: [],
      attachmentDocumentIds: [],
    });
  });

  it("sends chart values as the typed object the device built", () => {
    const values = { chart: "fluid_intake", ml: 200, iddsiLevel: "2", refused: false };
    const request = toCareUpload({
      op: "PUT",
      table: "observation",
      id: ID,
      opData: { ...base, chart: "fluid_intake", chart_values: JSON.stringify(values), flags: "{}" },
    });
    expect(request.kind === "request" && request.body).toEqual({
      id: ID,
      occurredAt: base.occurred_at,
      deviceTime: base.device_time,
      values,
    });
  });

  it("hazard HZ-019 sends the place drawn, the side drawn and the side chosen in words, and reads booleans", () => {
    const request = toCareUpload({
      op: "PUT",
      table: "body_map_mark",
      id: ID,
      opData: {
        ...base,
        view: "back",
        region: "sacrum",
        side: "midline",
        drawn_side: "midline",
        drawn_zone: "centre",
        drawn_x: 60.5,
        drawn_y: 110,
        mark_type: "pressure_ulcer",
        pressure_category: "category_2",
        device_related: 0,
        bruise_explained: null,
        length_mm: 12.5,
        width_mm: null,
        depth_mm: null,
        description: null,
        status: "present",
      },
    });
    expect(request.kind === "request" && request.body).toEqual({
      id: ID,
      occurredAt: base.occurred_at,
      deviceTime: base.device_time,
      view: "back",
      region: "sacrum",
      drawnAt: { x: 60.5, y: 110 },
      drawnZone: "centre",
      drawnSide: "midline",
      side: "midline",
      markType: "pressure_ulcer",
      pressureCategory: "category_2",
      deviceRelated: false,
      lengthMm: 12.5,
      status: "present",
    });
    expect(request.kind === "request" && CreateBodyMapMark.safeParse(request.body).success).toBe(
      true,
    );
  });

  it.each([
    // The front view faces the carer: the person's left is on the carer's right.
    ["front", "left", "viewer_right"],
    ["front", "right", "viewer_left"],
    ["back", "left", "viewer_left"],
    ["back", "midline", "centre"],
  ] as const)(
    "hazard HZ-019 sends an entry queued with only the side drawn (%s view, %s) as its zone of the drawing",
    (view, side, zone) => {
      const request = toCareUpload({
        op: "PUT",
        table: "body_map_mark",
        id: ID,
        opData: {
          ...base,
          view,
          region: "shin",
          side,
          drawn_side: side,
          mark_type: "rash",
          status: "present",
        },
      });
      expect(request.kind === "request" && request.body).toMatchObject({ drawnZone: zone });
      expect(request.kind === "request" && "drawnAt" in request.body).toBe(false);
    },
  );

  it("sends activities and visits with their own fields", () => {
    const activity = toCareUpload({
      op: "PUT",
      table: "activity_record",
      id: ID,
      opData: {
        ...base,
        activity: "Gardening",
        format: "one_to_one",
        attendance: "attended",
        duration_minutes: 30,
      },
    });
    expect(activity.kind === "request" && activity.body).toMatchObject({
      activity: "Gardening",
      format: "one_to_one",
      attendance: "attended",
      durationMinutes: 30,
    });
    const visit = toCareUpload({
      op: "PUT",
      table: "visit_log",
      id: ID,
      opData: { ...base, kind: "visit_out", visitor_name: "Invented visitor" },
    });
    expect(visit.kind === "request" && visit.body).toMatchObject({
      kind: "visit_out",
      visitorName: "Invented visitor",
      restrictionsApplied: false,
    });
  });

  it.each([
    ["PATCH", {}, "entry_not_editable"],
    ["DELETE", {}, "entry_not_editable"],
    ["PUT", { person_id: null }, "entry_incomplete"],
    ["PUT", { tenant_id: "" }, "entry_incomplete"],
    ["PUT", { occurred_at: null }, "entry_incomplete"],
    ["PUT", { tags: "{not json" }, "entry_unreadable"],
    ["PUT", { tags: "[1, 2]" }, "entry_unreadable"],
  ])("refuses a %s with %j as %s, with a reason to show", (op, change, code) => {
    const request = toCareUpload({
      op,
      table: "care_note",
      id: ID,
      opData: { ...base, category: "other", body: "Text", tags: "[]", ...change },
    });
    expect(request).toMatchObject({ kind: "refused", code, recordId: ID });
    expect(request.kind === "refused" && request.message.length).toBeGreaterThan(10);
  });

  it("refuses chart values that are not an object", () => {
    const request = toCareUpload({
      op: "PUT",
      table: "observation",
      id: ID,
      opData: { ...base, chart: "weight", chart_values: "[]" },
    });
    expect(request).toMatchObject({ kind: "refused", code: "entry_unreadable" });
  });
});
