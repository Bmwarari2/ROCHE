import { describe, expect, it } from "vitest";
import { currentEntries, entryStatus } from "./entries";
import { issueItem, markSummary, observationSummary, recentEntries } from "./entry-view";
import type { MarkRow, NoteRow, ObservationRow, UploadIssueRow } from "./queries";

const base = {
  recorded_at: "2026-10-11T09:00:05.123456Z",
  device_time: "2026-10-11T09:00:00.000Z",
  late_entry: 0,
  clock_drift: 0,
  supersedes_id: null,
  correction_reason: null,
};

const note = (id: string, overrides: Partial<NoteRow> = {}): NoteRow => ({
  ...base,
  id,
  occurred_at: "2026-10-11T09:00:00.000000Z",
  category: "personal_care",
  body: "Invented note",
  tags: "[]",
  ...overrides,
});

describe("hazard HZ-002 hazard HZ-006 entry status in words", () => {
  it.each([
    [{ recorded_at: null }, false, "queued"],
    [{ recorded_at: "2026-10-11T09:00:05Z" }, false, "saved"],
    [{ recorded_at: null }, true, "demo"],
  ] as const)("%j (demo %s) is %s", (row, demo, status) => {
    expect(entryStatus(row, demo)).toBe(status);
  });
});

describe("hazard HZ-017 corrections and late entries in lists", () => {
  it("shows the latest entry in each correction chain, with the reason", () => {
    const original = note("n1");
    const correction = note("n2", {
      supersedes_id: "n1",
      correction_reason: "Wrong time",
      occurred_at: "2026-10-11T08:30:00.000000Z",
    });
    const items = recentEntries([original, correction], [], [], false);
    expect(items.map((i) => i.id)).toEqual(["n2"]);
    expect(items[0]?.correction).toBe("Corrects an earlier entry. Reason: Wrong time");
  });

  it("keeps the order and drops only superseded rows", () => {
    expect(
      currentEntries([
        { id: "a", supersedes_id: null },
        { id: "b", supersedes_id: "a" },
        { id: "c", supersedes_id: null },
      ]).map((r) => r.id),
    ).toEqual(["b", "c"]);
  });

  it("carries the server's late-entry and clock-drift flags", () => {
    const [item] = recentEntries([note("n1", { late_entry: 1, clock_drift: 1 })], [], [], false);
    expect(item).toMatchObject({ late: true, clockDrift: true, status: "saved" });
  });

  it("shows when it happened in UK time", () => {
    const [item] = recentEntries([note("n1")], [], [], false);
    expect(item?.when).toBe("11/10/2026 at 10:00");
  });
});

describe("lists of entries", () => {
  it("puts notes, charts and marks together, newest first", () => {
    const observation: ObservationRow = {
      ...base,
      id: "o1",
      occurred_at: "2026-10-11T11:00:00.000Z",
      chart: "vitals",
      chart_values: "{}",
      flags: '{"news2":{"score":5,"band":"medium","clinicalRisk":"Medium"}}',
    };
    const mark: MarkRow = {
      ...base,
      id: "m1",
      occurred_at: "2026-10-11T10:00:00.000Z",
      view: "front",
      region: "shin",
      side: "left",
      mark_type: "bruise",
      pressure_category: null,
      status: "present",
      description: null,
    };
    const items = recentEntries([note("n1")], [observation], [mark], false);
    expect(items.map((i) => [i.id, i.title, i.summary])).toEqual([
      ["o1", "Vital signs", "NEWS2 5, clinical risk Medium"],
      ["m1", "Body map", "Bruise on Shin, the person's left"],
      ["n1", "Personal care", "Invented note"],
    ]);
    expect(items[0]?.news2?.score).toBe(5);
  });

  it.each([
    [
      "fluid_intake",
      { ml: 200, drink: "Tea", iddsiLevel: "2", refused: false },
      "200 ml, Tea, Level 2 Mildly thick (pink)",
    ],
    ["fluid_output", { ml: 350, kind: "urine" }, "350 ml, Urine"],
    [
      "food",
      { meal: "lunch", portion: "half", iddsiLevel: "5", refused: true },
      "Lunch: Half, Level 5 Minced and moist (orange), Refused",
    ],
    [
      "repositioning",
      { position: "left", skinChecked: true, declined: false },
      "Left side, Skin checked",
    ],
    [
      "bowel",
      { bristolType: 4, noMovement: false },
      "Type 4: Like a smooth, soft sausage or snake",
    ],
    ["bowel", { bristolType: null, noMovement: true }, "No bowel movement"],
    ["weight", { kg: 61.4, method: "chair" }, "61.4 kg, Chair scales"],
  ])("summarises %s %j", (chart, values, expected) => {
    expect(observationSummary(chart, JSON.stringify({ chart, ...values }), "{}")).toBe(expected);
  });

  it("summarises a mark in words", () => {
    expect(
      markSummary({ view: "back", region: "sacrum", side: "midline", mark_type: "pressure_ulcer" }),
    ).toBe("Pressure ulcer on Sacrum, the midline");
  });
});

describe("hazard HZ-006 refused entries stay readable", () => {
  it("names the person and the reason, and keeps what was written", () => {
    const row: UploadIssueRow = {
      id: "n9",
      person_id: "p1",
      record_table: "care_note",
      http_status: 422,
      code: "invalid",
      message: "This person's record is closed; only post-event notes can be added.",
      payload: JSON.stringify({ body: "Invented note", occurred_at: "2026-10-11T09:00:00.000Z" }),
      rejected_at: "2026-10-11T12:00:00.000Z",
      preferred_name: "Bea",
      given_name: "Beatrice",
      family_name: "Sample",
    };
    expect(issueItem(row)).toEqual({
      id: "n9",
      personId: "p1",
      title: "Note for Bea Sample",
      reason: "Reason: This person's record is closed; only post-event notes can be added.",
      content: "What was recorded: Invented note",
      when: "11/10/2026 at 10:00",
    });
  });

  it("still reads when the person is no longer on the device", () => {
    const item = issueItem({
      id: "o9",
      person_id: "gone",
      record_table: "observation",
      http_status: 404,
      code: "not_found",
      message: null,
      payload: JSON.stringify({
        chart: "weight",
        chart_values: '{"chart":"weight","kg":60,"method":"bed"}',
      }),
      rejected_at: null,
      preferred_name: null,
      given_name: null,
      family_name: null,
    });
    expect(item.title).toBe("Chart entry for Not recorded");
    expect(item.reason).toBe("Reason: The server did not say why.");
    expect(item.content).toBe("What was recorded: 60 kg, Bed scales");
  });
});
