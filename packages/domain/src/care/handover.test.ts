import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import {
  acknowledgementState,
  checkHandoverKeepsItems,
  compileHandover,
  HANDOVER_RATE_KEYS,
  type HandoverSources,
  type HandoverTaskSource,
  lateAdditionRecipients,
  MUST_FOLLOW_UP_TASK_KINDS,
  nextShift,
  observationIsRefusal,
  refreshHandover,
  ShiftPatternError,
  shiftAt,
  twoShiftPattern,
} from "./handover";

const PATTERN = twoShiftPattern(8 * 60, 20 * 60);
const THREE_SHIFTS = {
  starts: [
    { name: "early", minuteOfDay: 7 * 60 + 30 },
    { name: "late", minuteOfDay: 14 * 60 + 30 },
    { name: "night", minuteOfDay: 21 * 60 + 30 },
  ],
};
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
  it("resolves both start times for every nation into a valid pattern", () => {
    const rows = readRateTable();
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      const minute = (key: string) =>
        Number(resolveRate(rows, key, nation, "2026-10-11", null).value);
      const pattern = twoShiftPattern(
        minute(HANDOVER_RATE_KEYS.dayShiftStartMinute),
        minute(HANDOVER_RATE_KEYS.nightShiftStartMinute),
      );
      expect(shiftAt(t("2026-10-11T10:00:00Z"), pattern).name).toBe("day");
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
  ])("%s is the %s shift %s to %s (%s)", (at, name, start, end) => {
    const shift = shiftAt(t(at), PATTERN);
    expect([shift.name, shift.start.toISOString(), shift.end.toISOString()]).toEqual([
      name,
      start,
      end,
    ]);
  });

  it.each([
    ["2026-12-01T07:29:00Z", "night", "2026-11-30T21:30:00.000Z", "2026-12-01T07:30:00.000Z"],
    ["2026-12-01T07:30:00Z", "early", "2026-12-01T07:30:00.000Z", "2026-12-01T14:30:00.000Z"],
    ["2026-12-01T15:00:00Z", "late", "2026-12-01T14:30:00.000Z", "2026-12-01T21:30:00.000Z"],
    ["2026-12-01T23:00:00Z", "night", "2026-12-01T21:30:00.000Z", "2026-12-02T07:30:00.000Z"],
  ])("supports three shifts starting on the half hour: %s is %s", (at, name, start, end) => {
    const shift = shiftAt(t(at), THREE_SHIFTS);
    expect([shift.name, shift.start.toISOString(), shift.end.toISOString()]).toEqual([
      name,
      start,
      end,
    ]);
  });

  it.each([
    ["two shifts", PATTERN],
    ["three shifts", THREE_SHIFTS],
  ])("leaves no gap and no overlap across both clock changes (%s)", (_, pattern) => {
    for (const [from, to] of [
      ["2026-10-24T00:00:00Z", "2026-10-26T12:00:00Z"],
      ["2027-03-27T00:00:00Z", "2027-03-29T12:00:00Z"],
    ] as const) {
      for (let at = t(from).getTime(); at < t(to).getTime(); at += 5 * 60_000) {
        const shift = shiftAt(new Date(at), pattern);
        expect(shift.start.getTime()).toBeLessThanOrEqual(at);
        expect(shift.end.getTime()).toBeGreaterThan(at);
        expect(nextShift(shift, pattern).start.getTime()).toBe(shift.end.getTime());
      }
    }
  });

  it("hands the day shift over to the night shift and back", () => {
    const day = shiftAt(t("2026-10-11T10:00:00Z"), PATTERN);
    const night = nextShift(day, PATTERN);
    expect([night.name, night.start.toISOString()]).toEqual(["night", day.end.toISOString()]);
    expect(nextShift(night, PATTERN).name).toBe("day");
  });

  it.each([
    ["one shift", { starts: [{ name: "all day", minuteOfDay: 480 }] }],
    ["out of order", twoShiftPattern(1200, 480)],
    ["the same start twice", twoShiftPattern(480, 480)],
    ["past midnight", twoShiftPattern(480, 1440)],
    ["negative", twoShiftPattern(-1, 1200)],
    ["a fraction of a minute", twoShiftPattern(480.5, 1200)],
    [
      "an unnamed shift",
      {
        starts: [
          { name: " ", minuteOfDay: 480 },
          { name: "night", minuteOfDay: 1200 },
        ],
      },
    ],
  ])("refuses a pattern with %s", (_, pattern) => {
    expect(() => shiftAt(t("2026-10-11T10:00:00Z"), pattern)).toThrow(ShiftPatternError);
  });
});

describe("hazard HZ-018 refusals are read from every chart that records one", () => {
  it.each([
    [{ chart: "fluid_intake", refused: true }, true],
    [{ chart: "fluid_intake", refused: false }, false],
    [{ chart: "food", refused: true }, true],
    [{ chart: "food", refused: false }, false],
    [{ chart: "repositioning", declined: true }, true],
    [{ chart: "repositioning", declined: false }, false],
    [{ chart: "repositioning", refused: true }, false],
    [{ chart: "fluid_output" }, false],
    [{ chart: "bowel" }, false],
    [{ chart: "weight" }, false],
    [{ chart: "vitals" }, false],
  ])("%o is a refusal: %s", (values, expected) => {
    expect(observationIsRefusal(values)).toBe(expected);
  });

  it("names the MUST follow-up tasks by their care task kinds", () => {
    expect(MUST_FOLLOW_UP_TASK_KINDS).toEqual([
      "care.food_and_fluid_record",
      "care.dietitian_referral",
      "care.nutrition_assessment",
    ]);
  });
});

// The day shift on 11 October 2026: 08:00 to 20:00 BST.
const shift = shiftAt(t("2026-10-11T10:00:00Z"), PATTERN);
const compiledAt = t("2026-10-11T18:30:00Z");
const during = { occurredAt: t("2026-10-11T09:00:00Z"), recordedAt: t("2026-10-11T09:01:00Z") };

const task = (id: string, extra: Partial<HandoverTaskSource>): HandoverTaskSource => ({
  id,
  personId: "p2",
  kind: "care.repositioning",
  status: "open",
  priority: "routine",
  evidenceRequired: false,
  dueAt: t("2026-10-11T12:00:00Z"),
  windowEnd: null,
  createdAt: t("2026-10-10T12:00:00Z"),
  closedAt: null,
  ...extra,
});

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
    { id: "n-free-text", personId: "p4", tags: ["fell", "declined"], ...during },
  ],
  alerts: [
    {
      id: "a-urgent",
      personId: "p1",
      severity: "urgent",
      createdAt: t("2026-10-11T09:02:00Z"),
      acknowledgedAt: t("2026-10-11T09:10:00Z"),
    },
    {
      id: "a-warning",
      personId: "p1",
      severity: "warning",
      createdAt: t("2026-10-11T09:02:00Z"),
      acknowledgedAt: null,
    },
    {
      id: "a-unacknowledged",
      personId: "p2",
      severity: "urgent",
      createdAt: t("2026-10-11T02:00:00Z"),
      acknowledgedAt: null,
    },
    {
      id: "a-acknowledged-late",
      personId: "p2",
      severity: "urgent",
      createdAt: t("2026-10-11T02:00:00Z"),
      acknowledgedAt: t("2026-10-11T19:30:00Z"),
    },
    {
      id: "a-acknowledged-earlier",
      personId: "p2",
      severity: "urgent",
      createdAt: t("2026-10-11T02:00:00Z"),
      acknowledgedAt: t("2026-10-11T06:00:00Z"),
    },
  ],
  tasks: [
    task("t-overdue", { windowEnd: t("2026-10-11T12:30:00Z") }),
    task("t-overdue-no-window", { dueAt: t("2026-10-11T09:00:00Z") }),
    task("t-done", {
      status: "done",
      dueAt: t("2026-10-11T08:00:00Z"),
      closedAt: t("2026-10-11T08:10:00Z"),
    }),
    task("t-next-shift", { dueAt: t("2026-10-11T21:00:00Z") }),
    task("t-unfinished", {
      dueAt: t("2026-10-11T18:00:00Z"),
      windowEnd: t("2026-10-11T22:00:00Z"),
    }),
    task("t-skipped-urgent", {
      kind: "care.news2_response",
      status: "skipped",
      priority: "urgent",
      closedAt: t("2026-10-11T10:00:00Z"),
    }),
    task("t-skipped-evidence", {
      status: "cancelled",
      evidenceRequired: true,
      closedAt: t("2026-10-11T11:00:00Z"),
    }),
    task("t-skipped-routine", { status: "skipped", closedAt: t("2026-10-11T11:00:00Z") }),
    task("t-skipped-last-shift", {
      status: "skipped",
      priority: "urgent",
      closedAt: t("2026-10-11T05:00:00Z"),
    }),
    task("t-must", {
      personId: "p3",
      kind: "care.dietitian_referral",
      dueAt: t("2026-10-12T09:00:00Z"),
      createdAt: t("2026-10-11T09:05:00Z"),
    }),
    task("t-old-must", {
      personId: "p3",
      kind: "care.food_and_fluid_record",
      status: "in_progress",
      dueAt: t("2026-10-14T09:00:00Z"),
      createdAt: t("2026-10-08T09:05:00Z"),
    }),
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
    ["alert:a-urgent:p1", "an urgent alert raised this shift"],
    [
      "alert:a-unacknowledged:p2",
      "an urgent alert from an earlier shift that nobody has acknowledged",
    ],
    ["alert:a-acknowledged-late:p2", "an urgent alert acknowledged only after the shift ended"],
    ["body_map_mark:m-1:p3", "a new body-map mark"],
    ["overdue_task:t-overdue:p2", "a task still overdue at the end of the shift"],
    ["overdue_task:t-overdue-no-window:p2", "an overdue task with no window end"],
    ["skipped_task:t-skipped-urgent:p2", "an urgent task skipped this shift"],
    ["skipped_task:t-skipped-evidence:p2", "a task that needed evidence, cancelled this shift"],
    ["unfinished_task:t-unfinished:p2", "a task due this shift whose window runs past its end"],
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
    ["n-free-text", "free-text tags outside the fixed vocabulary"],
    ["a-warning", "a warning that is not urgent"],
    ["a-acknowledged-earlier", "an urgent alert acknowledged before this shift began"],
    ["t-done", "a finished task"],
    ["t-next-shift", "a task due next shift"],
    ["t-skipped-routine", "a routine task skipped with a reason"],
    ["t-skipped-last-shift", "a task skipped in an earlier shift"],
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

  it("compiles the 13-hour night when the clocks go back, including its last hour", () => {
    const night = shiftAt(t("2026-10-25T02:00:00Z"), PATTERN);
    const lastHour = {
      occurredAt: t("2026-10-25T07:30:00Z"),
      recordedAt: t("2026-10-25T07:31:00Z"),
    };
    const items = compileHandover(
      night,
      { ...empty, bodyMapMarks: [{ id: "m-night", personId: "p1", ...lastHour }] },
      t("2026-10-25T07:45:00Z"),
    );
    expect(items.map((i) => i.sourceId)).toEqual(["m-night"]);
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

  it("asks staff who acknowledged before a late addition to acknowledge the new items only", () => {
    const { items, added } = refreshHandover(first, shift, sources, later);
    const state = acknowledgementState(
      items,
      ["nurse", "carer", "carer", "bank"],
      [
        { tenantUserId: "nurse", at: t("2026-10-11T19:05:00Z"), itemsSeen: first.length },
        { tenantUserId: "carer", at: t("2026-10-11T20:20:00Z"), itemsSeen: items.length },
      ],
    );
    expect(state.acknowledged).toEqual(["carer"]);
    expect(state.pending).toEqual(["nurse", "bank"]);
    expect(state.complete).toBe(false);
    expect(state.unseen.get("nurse")).toEqual(added);
    expect(state.unseen.get("bank")).toEqual(items);
  });

  it("does not count an acknowledgement made in the same instant as a late addition", () => {
    const { items } = refreshHandover(first, shift, sources, later);
    const state = acknowledgementState(
      items,
      ["nurse"],
      [{ tenantUserId: "nurse", at: later, itemsSeen: first.length }],
    );
    expect(state.pending).toEqual(["nurse"]);
  });

  it("is complete once every incoming member of staff has acknowledged everything", () => {
    const state = acknowledgementState(
      first,
      ["nurse"],
      [{ tenantUserId: "nurse", at: t("2026-10-11T19:05:00Z"), itemsSeen: first.length }],
    );
    expect(state.complete).toBe(true);
    expect(acknowledgementState(first, [], []).complete).toBe(false);
  });

  it("sends a late addition to the incoming staff while their shift runs, then to the nurse in charge", () => {
    const receiving = nextShift(shift, PATTERN);
    expect(lateAdditionRecipients(receiving, later, ["carer", "carer"], ["nic"])).toEqual({
      to: "incoming_staff",
      recipients: ["carer"],
    });
    expect(lateAdditionRecipients(receiving, receiving.end, ["carer"], ["nic"])).toEqual({
      to: "nurse_in_charge",
      recipients: ["nic"],
    });
  });
});
