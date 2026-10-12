import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import {
  type AlertNotification,
  acknowledgementState,
  alertConditions,
  checkHandoverKeepsItems,
  checkHandoverNote,
  compileHandover,
  HANDOVER_CLOSED_MESSAGE,
  HANDOVER_NOTE_TAGS,
  HANDOVER_NOTIFICATION_KIND,
  HANDOVER_RATE_KEYS,
  HANDOVER_UNACKNOWLEDGED_KIND,
  type HandoverItem,
  type HandoverSources,
  type HandoverTaskSource,
  handoverOpen,
  incomingAcknowledged,
  lateAdditionNotices,
  lateAdditionSeverity,
  MAX_HANDOVER_NOTE_LENGTH,
  MUST_FOLLOW_UP_TASK_KINDS,
  nextShift,
  observationIsRefusal,
  previousShift,
  refreshHandover,
  ShiftPatternError,
  shiftAt,
  twoShiftPattern,
  unacknowledgedAlertDue,
  viewerAcknowledgement,
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
      const grace = minute(HANDOVER_RATE_KEYS.acknowledgementGraceMinutes);
      expect(grace).toBeGreaterThan(0);
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
      "2026-03-29T01:30:00Z",
      "night",
      "2026-03-28T20:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      "11 hours when the clocks go forward in 2026",
    ],
    [
      "2027-10-31T07:30:00Z",
      "night",
      "2027-10-30T19:00:00.000Z",
      "2027-10-31T08:00:00.000Z",
      "13 hours when the clocks go back in 2027, in its last hour",
    ],
    [
      "2027-10-31T08:00:00Z",
      "day",
      "2027-10-31T08:00:00.000Z",
      "2027-10-31T20:00:00.000Z",
      "the day after the 2027 change starts at 08:00 GMT",
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
    { id: "n-flagged", personId: "p4", tags: ["handover", "health"], ...during },
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
    ["flagged_note:n-flagged:p4", 'a note tagged "Include in handover"'],
  ])("includes %s (%s)", (key) => {
    expect(keys).toContain(key);
  });

  it.each([
    ["o-low", "a low NEWS2 band"],
    ["o-before", "an observation from the last shift recorded during it"],
    ["n-routine", "a routine note, not tagged for the handover"],
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

  it('hazard HZ-018 puts a note on the handover only when it is tagged "Include in handover"', () => {
    const note = (id: string, tags: string[]) => ({
      id,
      personId: "p1",
      occurredAt: t("2026-10-11T10:00:00Z"),
      recordedAt: t("2026-10-11T10:01:00Z"),
      tags,
    });
    const compiled = compileHandover(
      shift,
      {
        ...empty,
        notes: [
          note("untagged", []),
          note("tagged", [HANDOVER_NOTE_TAGS.handover]),
          note("typed", ["include in handover"]),
        ],
      },
      compiledAt,
    );
    expect(compiled.map((i) => [i.kind, i.sourceId])).toEqual([["flagged_note", "tagged"]]);
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

  it.each([
    [
      "the 11-hour night when the clocks go forward in 2027",
      "2027-03-28T02:00:00Z",
      "2027-03-28T06:50:00Z",
    ],
    [
      "the 13-hour night when the clocks go back in 2027",
      "2027-10-31T02:00:00Z",
      "2027-10-31T07:50:00Z",
    ],
  ])("compiles %s, including its last hour", (_label, during, lastHour) => {
    const night = shiftAt(t(during), PATTERN);
    const entry = { occurredAt: t(lastHour), recordedAt: t(lastHour) };
    const after = { occurredAt: night.end, recordedAt: night.end };
    const compiled = compileHandover(
      night,
      {
        ...empty,
        bodyMapMarks: [
          { id: "m-last-hour", personId: "p1", ...entry },
          { id: "m-next-shift", personId: "p1", ...after },
        ],
      },
      night.end,
    );
    expect(compiled.map((i) => i.sourceId)).toEqual(["m-last-hour"]);
  });
});

const keysOf = (items: readonly HandoverItem[]) => items.map((i) => i.key);

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
        { tenantUserId: "nurse", at: t("2026-10-11T19:05:00Z"), itemKeys: keysOf(first) },
        { tenantUserId: "carer", at: t("2026-10-11T20:20:00Z"), itemKeys: keysOf(items) },
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
      [{ tenantUserId: "nurse", at: later, itemKeys: keysOf(first) }],
    );
    expect(state.pending).toEqual(["nurse"]);
  });

  it("is complete once every incoming member of staff has acknowledged everything", () => {
    const state = acknowledgementState(
      first,
      ["nurse"],
      [{ tenantUserId: "nurse", at: t("2026-10-11T19:05:00Z"), itemKeys: keysOf(first) }],
    );
    expect(state.complete).toBe(true);
    expect(acknowledgementState(first, [], []).complete).toBe(false);
  });
});

describe("hazard HZ-018 the shift a handover compiles at the end of", () => {
  it.each([
    [
      "the day shift's handover from the night",
      "2026-10-11T10:00:00Z",
      "night",
      "2026-10-10T19:00:00.000Z",
    ],
    [
      "the night's handover from the day",
      "2026-10-11T22:00:00Z",
      "day",
      "2026-10-11T07:00:00.000Z",
    ],
    // The night of 24 to 25 October 2026 is 13 hours long; the day after it starts at 08:00 GMT.
    [
      "the 13-hour night when the clocks go back",
      "2026-10-25T09:00:00Z",
      "night",
      "2026-10-24T19:00:00.000Z",
    ],
    [
      "the 11-hour night when the clocks go forward in 2027",
      "2027-03-28T09:00:00Z",
      "night",
      "2027-03-27T20:00:00.000Z",
    ],
    [
      "the 13-hour night when the clocks go back in 2027",
      "2027-10-31T09:00:00Z",
      "night",
      "2027-10-30T19:00:00.000Z",
    ],
    [
      "the day before the 2027 spring change, from the night after it",
      "2027-03-28T20:30:00Z",
      "day",
      "2027-03-28T07:00:00.000Z",
    ],
  ])("%s", (_label, at, name, start) => {
    const before = previousShift(shiftAt(t(at), PATTERN), PATTERN);
    expect([before.name, before.start.toISOString()]).toEqual([name, start]);
    expect(before.end.getTime()).toBe(shiftAt(t(at), PATTERN).start.getTime());
  });

  it.each([
    ["while the shift runs", "2026-10-11T18:59:00Z", null, true],
    ["once the shift has ended", "2026-10-11T19:00:00Z", null, false],
    ["once it is locked, even early", "2026-10-11T18:00:00Z", "2026-10-11T17:59:00Z", false],
  ])("is open for notes %s", (_label, now, lockedAt, open) => {
    expect(handoverOpen(shift, lockedAt ? t(lockedAt) : null, t(now))).toBe(open);
  });
});

describe("hazard HZ-018 an urgent alert is one item however many people it reached", () => {
  const n = (
    id: string,
    extra: Omit<Partial<AlertNotification>, "createdAt"> & { createdAt: string },
  ): AlertNotification => ({
    id,
    kind: "care.urgent_result",
    severity: "urgent",
    sourceType: "observation",
    sourceId: "o-high",
    personId: "p1",
    acknowledgedAt: null,
    ...extra,
    createdAt: t(extra.createdAt),
  });

  it("groups each recipient's copy, keeps the first, and counts it acknowledged once anyone has", () => {
    const alerts = alertConditions([
      n("n-nurse", {
        createdAt: "2026-10-11T09:02:00Z",
        acknowledgedAt: t("2026-10-11T09:20:00Z"),
      }),
      n("n-lead", { createdAt: "2026-10-11T09:02:00Z", acknowledgedAt: t("2026-10-11T09:10:00Z") }),
      n("n-manager", { createdAt: "2026-10-11T09:03:00Z" }),
      n("n-other", { createdAt: "2026-10-11T09:05:00Z", sourceId: "o-other", personId: "p2" }),
    ]);
    expect(alerts).toEqual([
      {
        id: "n-lead",
        personId: "p1",
        severity: "urgent",
        createdAt: t("2026-10-11T09:02:00Z"),
        acknowledgedAt: t("2026-10-11T09:10:00Z"),
      },
      {
        id: "n-other",
        personId: "p2",
        severity: "urgent",
        createdAt: t("2026-10-11T09:05:00Z"),
        acknowledgedAt: null,
      },
    ]);
  });

  it("leaves out escalation copies and the handover's own notices, so it never lists itself", () => {
    expect(
      alertConditions([
        n("escalated", {
          createdAt: "2026-10-11T09:12:00Z",
          sourceType: "notification",
          sourceId: "n-1",
        }),
        n("handover", { createdAt: "2026-10-11T09:12:00Z", kind: HANDOVER_NOTIFICATION_KIND }),
        n("unacknowledged", {
          createdAt: "2026-10-11T09:12:00Z",
          kind: HANDOVER_UNACKNOWLEDGED_KIND,
        }),
      ]),
    ).toEqual([]);
  });

  it("keeps an alert with no source as its own condition", () => {
    const alerts = alertConditions([
      n("a", { createdAt: "2026-10-11T09:00:00Z", sourceType: null, sourceId: null }),
      n("b", { createdAt: "2026-10-11T09:00:00Z", sourceType: null, sourceId: null }),
    ]);
    expect(alerts.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("hazard HZ-018 each member of staff acknowledges the items they can see", () => {
  const first = compileHandover(
    shift,
    { ...empty, bodyMapMarks: sources.bodyMapMarks },
    compiledAt,
  );
  const later = t("2026-10-11T20:15:00Z");
  const { items, added } = refreshHandover(first, shift, sources, later);
  const assigned = new Set(["p3"]);
  const visible = (i: HandoverItem) => i.personId === null || assigned.has(i.personId);

  it("shows everything visible to someone who has not acknowledged", () => {
    const state = viewerAcknowledgement(items, visible, [], "carer");
    expect(state.acknowledged).toBe(false);
    expect(state.acknowledgedAt).toBeNull();
    expect(state.unseen).toEqual(items.filter(visible));
  });

  it("asks again only for late additions they can see", () => {
    const acks = [
      {
        tenantUserId: "carer",
        at: t("2026-10-11T19:05:00Z"),
        itemKeys: keysOf(first.filter(visible)),
      },
    ];
    const state = viewerAcknowledgement(items, visible, acks, "carer");
    expect(state.unseen).toEqual(added.filter(visible));
    expect(state.unseen.length).toBeGreaterThan(0);
    expect(state.acknowledged).toBe(false);
    // Late additions only about other people do not make them pending again.
    const onlyOthers = viewerAcknowledgement(
      items,
      (i) => i.personId === "p3" && !i.lateAddition,
      acks,
      "carer",
    );
    expect(onlyOthers).toMatchObject({ acknowledged: true, unseen: [] });
  });

  it("counts every acknowledgement of their own by its keys, never another person's", () => {
    const state = viewerAcknowledgement(
      items,
      visible,
      [
        { tenantUserId: "carer", at: t("2026-10-11T19:05:00Z"), itemKeys: keysOf(first) },
        { tenantUserId: "carer", at: t("2026-10-11T20:20:00Z"), itemKeys: keysOf(added) },
        { tenantUserId: "nurse", at: t("2026-10-11T20:30:00Z"), itemKeys: keysOf(items) },
      ],
      "carer",
    );
    expect(state).toMatchObject({ acknowledged: true, unseen: [] });
    expect(state.acknowledgedAt).toEqual(t("2026-10-11T20:20:00Z"));
    expect(viewerAcknowledgement(items, visible, [], "nurse").acknowledged).toBe(false);
  });
});

describe("hazard HZ-018 the incoming shift has acknowledged only when its acknowledgements cover every item", () => {
  const first = compileHandover(shift, sources, compiledAt);
  const carerKeys = keysOf(first.filter((i) => i.personId === null || i.personId === "p3"));
  const otherKeys = keysOf(first).filter((k) => !carerKeys.includes(k));
  const at = (iso: string, user: string, keys: readonly string[]) => ({
    tenantUserId: user,
    at: t(iso),
    itemKeys: keys,
  });

  it.each([
    ["nobody has acknowledged", [], false],
    [
      "only the outgoing staff read it back, before the shift ended",
      [at("2026-10-11T18:55:00Z", "nurse", keysOf(first))],
      false,
    ],
    [
      "the incoming nurse acknowledged every item after the shift ended",
      [at("2026-10-11T19:05:00Z", "nurse", keysOf(first))],
      true,
    ],
    [
      "the acknowledgement at the moment the shift ended counts",
      [at("2026-10-11T19:00:00Z", "nurse", keysOf(first))],
      true,
    ],
    [
      "an acknowledgement that misses an item does not count",
      [at("2026-10-11T19:05:00Z", "nurse", keysOf(first).slice(1))],
      false,
    ],
    [
      "a carer who acknowledged only their own people's items does not clear it",
      [at("2026-10-11T19:05:00Z", "carer", carerKeys)],
      false,
    ],
    [
      "two people on the incoming shift together cover every item",
      [
        at("2026-10-11T19:05:00Z", "carer", carerKeys),
        at("2026-10-11T19:20:00Z", "nurse", otherKeys),
      ],
      true,
    ],
    [
      "the outgoing staff's earlier read-back never fills the gap an incoming one leaves",
      [
        at("2026-10-11T18:55:00Z", "nurse", keysOf(first)),
        at("2026-10-11T19:05:00Z", "carer", carerKeys),
      ],
      false,
    ],
  ] as const)("%s: %s", (_label, acks, expected) => {
    expect(carerKeys.length).toBeGreaterThan(0);
    expect(otherKeys.length).toBeGreaterThan(0);
    expect(incomingAcknowledged(shift, first, acks)).toBe(expected);
  });

  it("needs an acknowledgement on the incoming shift even for an empty handover", () => {
    expect(incomingAcknowledged(shift, [], [])).toBe(false);
    expect(incomingAcknowledged(shift, [], [at("2026-10-11T19:05:00Z", "agency", [])])).toBe(true);
    expect(incomingAcknowledged(shift, first, [at("2026-10-11T19:05:00Z", "agency", [])])).toBe(
      false,
    );
  });

  it("is overtaken by a late addition nobody on the incoming shift has acknowledged", () => {
    const late = refreshHandover(
      first,
      shift,
      {
        ...sources,
        bodyMapMarks: [
          ...sources.bodyMapMarks,
          {
            id: "m-late",
            personId: "p1",
            occurredAt: t("2026-10-11T18:00:00Z"),
            recordedAt: t("2026-10-11T19:30:00Z"),
          },
        ],
      },
      t("2026-10-11T19:35:00Z"),
    ).items;
    const acks = [at("2026-10-11T19:05:00Z", "nurse", keysOf(first))];
    expect(incomingAcknowledged(shift, late, acks)).toBe(false);
  });

  it.each([
    ["before the grace period ends", "2026-10-11T19:59:00Z", false, false],
    ["once the grace period has passed", "2026-10-11T20:00:00Z", false, true],
    ["a day after it fell due", "2026-10-12T19:59:00Z", false, true],
    ["no longer, once a day has passed", "2026-10-12T20:00:00Z", false, false],
    [
      "never once someone on the incoming shift has acknowledged",
      "2026-10-11T20:30:00Z",
      true,
      false,
    ],
  ])("alerts the nurse in charge %s", (_label, now, acknowledged, due) => {
    expect(unacknowledgedAlertDue({ shift, now: t(now), graceMinutes: 60, acknowledged })).toBe(
      due,
    );
  });
});

describe("hazard HZ-018 notes add to a handover; they never replace an item", () => {
  const keys = ["fall:incident:i-1:p1", "news2:observation:o-1:p2"];
  it.each([
    ["a general note while open", { open: true, body: "Lift out of order.", itemKey: null }, null],
    ["a note on an item", { open: true, body: "GP called back.", itemKey: keys[0] ?? null }, null],
    [
      "a blank note",
      { open: true, body: "   ", itemKey: null },
      "Write the note before saving it.",
    ],
    [
      "a note on an item the handover does not have",
      { open: true, body: "Seen.", itemKey: "fall:incident:other:p9" },
      "That item is not on this handover.",
    ],
    [
      "a note once the handover has closed",
      { open: false, body: "Seen.", itemKey: null },
      'This handover has closed. Add a care note tagged "Include in handover" instead: the next handover carries it, and if you time it within this shift it is added to this handover too.',
    ],
  ])("%s", (_label, input, message) => {
    const check = checkHandoverNote({ ...input, itemKeys: keys });
    expect(check.ok ? null : check.message).toBe(message);
  });

  it("names the tag that reaches the next handover when this one has closed", () => {
    expect(HANDOVER_CLOSED_MESSAGE).toContain("Include in handover");
    expect(HANDOVER_NOTE_TAGS.handover).toBe("handover");
  });

  it("refuses a note longer than the limit", () => {
    const check = checkHandoverNote({
      open: true,
      body: "a".repeat(MAX_HANDOVER_NOTE_LENGTH + 1),
      itemKey: null,
      itemKeys: keys,
    });
    expect(check.ok).toBe(false);
  });
});

describe("hazard HZ-008 a late addition interrupts only for what cannot wait", () => {
  const item = (kind: HandoverItem["kind"]): HandoverItem => ({
    key: `${kind}:x`,
    kind,
    personId: "p1",
    sourceType: "task",
    sourceId: "x",
    at: compiledAt,
    lateAddition: true,
    addedAt: compiledAt,
  });
  it.each([
    [[], null],
    [["refusal", "overdue_task"], "warning"],
    [["body_map_mark"], "warning"],
    [["refusal", "fall"], "urgent"],
    [["news2"], "urgent"],
    [["incident"], "urgent"],
    [["alert"], "urgent"],
  ] as const)("added %j: %s", (kinds, severity) => {
    expect(lateAdditionSeverity(kinds.map(item))).toBe(severity);
  });
});

describe("hazards HZ-018 and HZ-008 a late addition always reaches someone who can act on it", () => {
  const receiving = nextShift(shift, PATTERN);
  const during = t("2026-10-12T02:00:00Z");
  const after = receiving.end;
  const item = (
    key: string,
    kind: HandoverItem["kind"],
    personId: string | null,
  ): HandoverItem => ({
    key,
    kind,
    personId,
    sourceType: "observation",
    sourceId: key,
    at: compiledAt,
    lateAddition: true,
    addedAt: during,
  });
  const fall = item("fall-p1", "fall", "p1");
  const refusalP1 = item("refusal-p1", "refusal", "p1");
  const refusalP2 = item("refusal-p2", "refusal", "p2");
  const markP3 = item("mark-p3", "body_map_mark", "p3");
  // The carer looks after p1 only; the nurse in charge sees everyone at the location.
  const canSee = (user: string, i: HandoverItem) =>
    user === "nic" || i.personId === null || (user === "carer" && i.personId === "p1");
  // The care worker acknowledged on the receiving shift.
  const carerAck = { tenantUserId: "carer", at: t("2026-10-11T19:10:00Z") };
  const summary = (r: ReturnType<typeof lateAdditionNotices>) =>
    r.notices.map((n) => [n.recipient, n.severity, n.items.map((i) => i.key)]);

  it("tells the acknowledger what they can see, and the nurse in charge what nobody else can", () => {
    const result = lateAdditionNotices({
      receivingShift: receiving,
      now: during,
      added: [refusalP1, refusalP2, markP3],
      acknowledgements: [carerAck],
      nurseInCharge: ["nic"],
      canSee,
    });
    expect(summary(result)).toEqual([
      ["carer", "warning", ["refusal-p1"]],
      ["nic", "warning", ["refusal-p2", "mark-p3"]],
    ]);
    expect(result.unheard).toEqual([]);
  });

  it("always tells the nurse in charge about a fall, a raised NEWS2, an incident or an urgent alert", () => {
    const result = lateAdditionNotices({
      receivingShift: receiving,
      now: during,
      added: [fall, refusalP1],
      acknowledgements: [carerAck],
      nurseInCharge: ["nic"],
      canSee,
    });
    expect(summary(result)).toEqual([
      ["carer", "urgent", ["fall-p1", "refusal-p1"]],
      ["nic", "urgent", ["fall-p1"]],
    ]);
  });

  it("tells the nurse in charge about everything when nobody has acknowledged", () => {
    const result = lateAdditionNotices({
      receivingShift: receiving,
      now: during,
      added: [refusalP1, markP3],
      acknowledgements: [],
      nurseInCharge: ["nic"],
      canSee,
    });
    expect(summary(result)).toEqual([["nic", "warning", ["refusal-p1", "mark-p3"]]]);
  });

  it("tells only the nurse in charge once the receiving shift has ended", () => {
    const result = lateAdditionNotices({
      receivingShift: receiving,
      now: after,
      added: [refusalP1],
      acknowledgements: [carerAck],
      nurseInCharge: ["nic"],
      canSee,
    });
    expect(summary(result)).toEqual([["nic", "warning", ["refusal-p1"]]]);
  });

  it("never interrupts anyone for an item they cannot see, and records an item nobody can see", () => {
    const result = lateAdditionNotices({
      receivingShift: receiving,
      now: during,
      added: [item("fall-p9", "fall", "p9"), refusalP1],
      acknowledgements: [carerAck],
      nurseInCharge: [],
      canSee: (user, i) => user === "carer" && i.personId === "p1",
    });
    expect(summary(result)).toEqual([["carer", "warning", ["refusal-p1"]]]);
    expect(result.unheard.map((i) => i.key)).toEqual(["fall-p9"]);
  });

  it("hazard HZ-008 sends nothing before the receiving shift starts: the additions are part of the handover it will read", () => {
    const result = lateAdditionNotices({
      receivingShift: receiving,
      now: t("2026-10-11T18:50:00Z"),
      added: [fall, refusalP1],
      acknowledgements: [{ tenantUserId: "carer", at: t("2026-10-11T18:40:00Z") }],
      nurseInCharge: ["nic"],
      canSee,
    });
    expect(result).toEqual({ notices: [], unheard: [] });
  });

  it("does not count the outgoing staff's read-back: the nurse in charge hears what nobody incoming has seen", () => {
    const result = lateAdditionNotices({
      receivingShift: receiving,
      now: during,
      added: [refusalP1, markP3],
      acknowledgements: [{ tenantUserId: "carer", at: t("2026-10-11T18:55:00Z") }],
      nurseInCharge: ["nic"],
      canSee,
    });
    expect(summary(result)).toEqual([["nic", "warning", ["refusal-p1", "mark-p3"]]]);
  });

  it("sends nothing when nothing was added", () => {
    expect(
      lateAdditionNotices({
        receivingShift: receiving,
        now: during,
        added: [],
        acknowledgements: [carerAck],
        nurseInCharge: ["nic"],
        canSee,
      }),
    ).toEqual({ notices: [], unheard: [] });
  });
});
