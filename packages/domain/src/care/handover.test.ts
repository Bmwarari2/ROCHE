import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import {
  acknowledgementState,
  checkHandoverKeepsItems,
  compileHandover,
  HANDOVER_RATE_KEYS,
  type HandoverSources,
  nextShift,
  refreshHandover,
  ShiftPatternError,
  shiftAt,
} from "./handover";

const PATTERN = { dayStartHour: 8, nightStartHour: 20 };
const t = (iso: string) => new Date(iso);
const empty: HandoverSources = {
  tasks: [],
  observations: [],
  incidents: [],
  bodyMapMarks: [],
  notes: [],
  alerts: [],
};

describe("the shift pattern comes from the rate table", () => {
  it("resolves both start hours for every nation into a valid pattern", () => {
    const rows = readRateTable();
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      const hour = (key: string) =>
        Number(resolveRate(rows, key, nation, "2026-10-11", null).value);
      const pattern = {
        dayStartHour: hour(HANDOVER_RATE_KEYS.dayShiftStartHour),
        nightStartHour: hour(HANDOVER_RATE_KEYS.nightShiftStartHour),
      };
      expect(shiftAt(t("2026-10-11T10:00:00Z"), pattern).kind).toBe("day");
    }
  });
});

describe("shiftAt", () => {
  it.each([
    [
      "2026-10-11T10:00:00Z",
      "day",
      "2026-10-11T07:00:00.000Z",
      "2026-10-11T19:00:00.000Z",
      "a summer day shift",
    ],
    [
      "2026-10-11T07:00:00Z",
      "day",
      "2026-10-11T07:00:00.000Z",
      "2026-10-11T19:00:00.000Z",
      "08:00 BST starts the day shift",
    ],
    [
      "2026-10-11T22:00:00Z",
      "night",
      "2026-10-11T19:00:00.000Z",
      "2026-10-12T07:00:00.000Z",
      "a night shift before midnight",
    ],
    [
      "2026-10-12T03:00:00Z",
      "night",
      "2026-10-11T19:00:00.000Z",
      "2026-10-12T07:00:00.000Z",
      "a night shift after midnight",
    ],
    [
      "2026-10-25T02:00:00Z",
      "night",
      "2026-10-24T19:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
      "13 hours when the clocks go back",
    ],
    [
      "2027-03-28T03:00:00Z",
      "night",
      "2027-03-27T20:00:00.000Z",
      "2027-03-28T07:00:00.000Z",
      "11 hours when the clocks go forward",
    ],
    [
      "2026-12-01T12:00:00Z",
      "day",
      "2026-12-01T08:00:00.000Z",
      "2026-12-01T20:00:00.000Z",
      "a winter day shift",
    ],
  ])("%s is the %s shift %s to %s (%s)", (at, kind, start, end) => {
    const shift = shiftAt(t(at), PATTERN);
    expect([shift.kind, shift.start.toISOString(), shift.end.toISOString()]).toEqual([
      kind,
      start,
      end,
    ]);
  });

  it("hands the day shift over to the night shift and back", () => {
    const day = shiftAt(t("2026-10-11T10:00:00Z"), PATTERN);
    const night = nextShift(day, PATTERN);
    expect([night.kind, night.start.toISOString()]).toEqual(["night", day.end.toISOString()]);
    expect(nextShift(night, PATTERN).kind).toBe("day");
  });

  it.each([
    [{ dayStartHour: 20, nightStartHour: 8 }],
    [{ dayStartHour: 8, nightStartHour: 24 }],
    [{ dayStartHour: -1, nightStartHour: 20 }],
    [{ dayStartHour: 7.5, nightStartHour: 20 }],
    [{ dayStartHour: 8, nightStartHour: 8 }],
  ])("refuses the pattern %o", (pattern) => {
    expect(() => shiftAt(t("2026-10-11T10:00:00Z"), pattern)).toThrow(ShiftPatternError);
  });
});

// The day shift on 11 October 2026: 08:00 to 20:00 BST.
const shift = shiftAt(t("2026-10-11T10:00:00Z"), PATTERN);
const compiledAt = t("2026-10-11T18:30:00Z");
const during = { occurredAt: t("2026-10-11T09:00:00Z"), recordedAt: t("2026-10-11T09:01:00Z") };

const sources: HandoverSources = {
  observations: [
    { id: "o-high", personId: "p1", news2Band: "high", refused: false, ...during },
    { id: "o-single3", personId: "p2", news2Band: "low_medium", refused: false, ...during },
    { id: "o-low", personId: "p3", news2Band: "low", refused: false, ...during },
    { id: "o-refused", personId: "p3", news2Band: null, refused: true, ...during },
    {
      id: "o-before",
      personId: "p1",
      news2Band: "high",
      refused: false,
      occurredAt: t("2026-10-11T05:00:00Z"),
      recordedAt: t("2026-10-11T05:02:00Z"),
    },
    {
      id: "o-synced-late",
      personId: "p2",
      news2Band: "medium",
      refused: false,
      occurredAt: t("2026-10-11T03:00:00Z"),
      recordedAt: t("2026-10-11T11:00:00Z"),
    },
  ],
  incidents: [
    { id: "i-fall", personIds: ["p1", "p2"], type: "fall", ...during },
    { id: "i-fall", personIds: ["p1", "p2"], type: "fall", ...during },
    { id: "i-utility", personIds: [], type: "utility_failure", ...during },
  ],
  bodyMapMarks: [{ id: "m-1", personId: "p3", ...during }],
  notes: [
    { id: "n-fall", personId: "p4", tags: ["fall"], ...during },
    { id: "n-refusal", personId: "p4", tags: ["refusal", "personal_care"], ...during },
    { id: "n-routine", personId: "p4", tags: ["mood"], ...during },
  ],
  alerts: [
    { id: "a-urgent", personId: "p1", severity: "urgent", createdAt: t("2026-10-11T09:02:00Z") },
    { id: "a-routine", personId: "p1", severity: "routine", createdAt: t("2026-10-11T09:02:00Z") },
  ],
  tasks: [
    {
      id: "t-overdue",
      personId: "p2",
      kind: "care.repositioning",
      status: "open",
      dueAt: t("2026-10-11T12:00:00Z"),
      windowEnd: t("2026-10-11T12:30:00Z"),
      createdAt: t("2026-10-10T12:00:00Z"),
    },
    {
      id: "t-done",
      personId: "p2",
      kind: "care.repositioning",
      status: "done",
      dueAt: t("2026-10-11T08:00:00Z"),
      windowEnd: null,
      createdAt: t("2026-10-10T12:00:00Z"),
    },
    {
      id: "t-next-shift",
      personId: "p2",
      kind: "care.repositioning",
      status: "open",
      dueAt: t("2026-10-11T21:00:00Z"),
      windowEnd: null,
      createdAt: t("2026-10-10T12:00:00Z"),
    },
    {
      id: "t-must",
      personId: "p3",
      kind: "care.dietitian_referral",
      status: "open",
      dueAt: t("2026-10-12T09:00:00Z"),
      windowEnd: null,
      createdAt: t("2026-10-11T09:05:00Z"),
    },
    {
      id: "t-old-must",
      personId: "p3",
      kind: "care.food_and_fluid_record",
      status: "in_progress",
      dueAt: t("2026-10-14T09:00:00Z"),
      windowEnd: null,
      createdAt: t("2026-10-08T09:05:00Z"),
    },
  ],
};

describe("hazard HZ-018 handover includes every safety-critical item from the shift", () => {
  const items = compileHandover(shift, sources, compiledAt);
  const keys = items.map((i) => `${i.kind}:${i.sourceId}:${i.personId ?? "-"}`);

  it.each([
    ["fall:i-fall:p1", "a fall, for each person involved"],
    ["fall:i-fall:p2", "a fall, for each person involved"],
    ["fall:n-fall:p4", "a fall written in a note before the incident form"],
    ["news2:o-high:p1", "a high NEWS2 band"],
    ["news2:o-single3:p2", "a single parameter scoring 3"],
    ["news2:o-synced-late:p2", "an observation from the last shift that synced during this one"],
    ["incident:i-utility:-", "an incident not tied to a person"],
    ["alert:a-urgent:p1", "an urgent alert"],
    ["body_map_mark:m-1:p3", "a new body-map mark"],
    ["overdue_task:t-overdue:p2", "a task still overdue at the end of the shift"],
    ["must_follow_up:t-must:p3", "a MUST follow-up raised this shift"],
    ["refusal:o-refused:p3", "a refused drink"],
    ["refusal:n-refusal:p4", "refused personal care"],
  ])("includes %s (%s)", (key) => {
    expect(keys).toContain(key);
  });

  it.each([
    ["o-low", "a low NEWS2 band"],
    ["o-before", "an observation from the last shift recorded during it"],
    ["n-routine", "a routine note"],
    ["a-routine", "a routine alert"],
    ["t-done", "a finished task"],
    ["t-next-shift", "a task due next shift"],
    ["t-old-must", "a MUST follow-up from an earlier shift that is not yet overdue"],
  ])("leaves out %s (%s)", (id) => {
    expect(items.some((i) => i.sourceId === id)).toBe(false);
  });

  it("lists each record once, falls first and refusals last", () => {
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    expect(items[0]?.kind).toBe("fall");
    expect(items.at(-1)?.kind).toBe("refusal");
    expect(items.every((i) => !i.lateAddition && i.addedAt === compiledAt)).toBe(true);
  });

  it("compiles an empty shift to an empty handover", () => {
    expect(compileHandover(shift, empty, compiledAt)).toEqual([]);
  });
});

describe("hazard HZ-018 items synced after compilation are appended as late additions", () => {
  const first = compileHandover(
    shift,
    { ...empty, bodyMapMarks: sources.bodyMapMarks },
    compiledAt,
  );
  const later = t("2026-10-11T20:15:00Z");

  it("appends new items, marked late, and keeps every existing item", () => {
    const { items, added } = refreshHandover(first, shift, sources, later);
    expect(items.slice(0, first.length)).toEqual(first);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((i) => i.lateAddition && i.addedAt === later)).toBe(true);
    expect(items.filter((i) => i.sourceId === "m-1")).toHaveLength(1);
  });

  it("keeps an item even when its source no longer qualifies", () => {
    const { items, added } = refreshHandover(first, shift, empty, later);
    expect(items).toEqual(first);
    expect(added).toEqual([]);
  });

  it("refuses an update that drops an item, and allows one that adds", () => {
    const keys = first.map((i) => i.key);
    expect(checkHandoverKeepsItems(first, [...keys, "extra"])).toEqual({ ok: true });
    const result = checkHandoverKeepsItems(first, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toEqual(keys);
  });

  it("asks staff who acknowledged before a late addition to acknowledge again", () => {
    const { items } = refreshHandover(first, shift, sources, later);
    const state = acknowledgementState(
      items,
      ["nurse", "carer", "carer"],
      [
        { tenantUserId: "nurse", at: t("2026-10-11T19:05:00Z") },
        { tenantUserId: "carer", at: t("2026-10-11T20:20:00Z") },
      ],
    );
    expect(state).toEqual({ acknowledged: ["carer"], pending: ["nurse"], complete: false });
  });

  it("is complete once every incoming member of staff has acknowledged", () => {
    const state = acknowledgementState(
      first,
      ["nurse"],
      [{ tenantUserId: "nurse", at: t("2026-10-11T19:05:00Z") }],
    );
    expect(state.complete).toBe(true);
    expect(acknowledgementState(first, [], []).complete).toBe(false);
  });
});
