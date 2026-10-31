import { describe, expect, it } from "vitest";
import {
  CHECKER,
  draft,
  entry,
  ORAL,
  PERSON,
  PRODUCT,
  SOURCE,
  SUBCUTANEOUS,
  TABLET_FACTS,
  TRANSCRIBER,
  UNIT,
} from "../../test/medicines-fixtures";
import { formatUkTime, fromUkWallClock } from "../shared/time";
import {
  changeMarEntry,
  checkMarEntryDraft,
  MAR_ENTRY_NOTICES,
  type MarEntry,
  type MarEntryDraft,
  type MarEntryProblem,
  type MarSourceKind,
  marEntryDoses,
  marEntryEnd,
  marEntryStatus,
  recordSecondCheck,
  type SecondCheckInput,
  stopMarEntry,
  transcribeMarEntry,
} from "./mar-entry";

const checkedAt = new Date("2026-11-01T11:00:00Z");
/** The fixture entries start at 00:00 on 02/11/2026; this is a time they are in force. */
const inForce = new Date("2026-11-02T09:00:00Z");
const goodCheck: SecondCheckInput = {
  by: CHECKER,
  at: checkedAt,
  competence: "current",
  comparedWithSource: true,
  outcome: "matches_source",
  difference: null,
};
function checked(e: MarEntry = entry()): MarEntry {
  const result = recordSecondCheck(e, goodCheck);
  if (!result.ok) throw new Error("check refused");
  return result.entry;
}
const prn: MarEntryDraft["directions"] = {
  kind: "when_required",
  dose: { kind: "range", from: 1, to: 2, unit: UNIT.tablet },
};
/** 00:00 UK time on a day of November 2026 (past the 30th it runs into December). */
const midnight = (d: number) => {
  const x = new Date(Date.UTC(2026, 10, d));
  return fromUkWallClock(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), 0, 0);
};
const day = (d: number) => ({ from: midnight(d), to: midnight(d + 1) });

describe("a MAR entry is a dm+d product with structured doses and its source document", () => {
  it("accepts a complete entry", () => {
    expect(checkMarEntryDraft(draft(), TABLET_FACTS)).toEqual([]);
    expect(checkMarEntryDraft(draft({ directions: prn }), TABLET_FACTS)).toEqual([]);
  });

  it.each<[string, Partial<MarEntryDraft>, MarEntryProblem[]]>([
    [
      "a typed medicine name",
      { product: { vmpId: "Paracetamol", ampId: null, name: "Paracetamol" } },
      ["product_not_dmd"],
    ],
    [
      "a brand whose identifier fails its check digit",
      { product: { ...PRODUCT.paracetamolBrandA, ampId: "90000021000001109" } },
      ["product_not_dmd"],
    ],
    [
      "a route dm+d does not give for the product",
      { route: SUBCUTANEOUS },
      ["route_not_permitted"],
    ],
    [
      "a dose in a unit dm+d does not give for the product",
      {
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [{ time: "08:00", dose: { kind: "amount", quantity: 5, unit: UNIT.ml } }],
          },
        },
      },
      ["unit_not_permitted"],
    ],
    [
      "a when-required medicine with no indication",
      { directions: prn, indication: " " },
      ["indication_required"],
    ],
    [
      "a when-required dose in a unit dm+d does not give",
      {
        directions: {
          kind: "when_required",
          dose: { kind: "amount", quantity: 10, unit: UNIT.ml },
        },
      },
      ["unit_not_permitted"],
    ],
    ["no prescriber", { prescriber: "" }, ["prescriber_required"]],
    ["no source reference", { source: { ...SOURCE, reference: "  " } }, ["source_required"]],
    [
      "a verbal instruction as the source",
      { source: { ...SOURCE, kind: "verbal" as MarSourceKind } },
      ["source_required"],
    ],
    [
      "a stop before the start",
      { stopsAt: new Date("2026-11-01T00:00:00Z") },
      ["stops_before_starts"],
    ],
    ["a review date that does not exist", { reviewOn: "2027-02-30" }, ["bad_review_date"]],
    ["a review date in another format", { reviewOn: "01/05/2027" }, ["bad_review_date"]],
  ])("refuses %s", (_name, overrides, problems) => {
    expect(checkMarEntryDraft(draft(overrides), TABLET_FACTS).map((i) => i.problem)).toEqual(
      problems,
    );
  });

  it("returns every problem at once", () => {
    const problems = checkMarEntryDraft(
      draft({ prescriber: "", reviewOn: "soon", route: SUBCUTANEOUS }),
      TABLET_FACTS,
    );
    expect(problems.map((i) => i.problem)).toEqual([
      "route_not_permitted",
      "prescriber_required",
      "bad_review_date",
    ]);
    expect(
      transcribeMarEntry(draft({ prescriber: "" }), TABLET_FACTS, {
        id: "e",
        by: TRANSCRIBER,
        at: checkedAt,
        origin: "transcribed",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("hazard HZ-005 a new or changed MAR entry stays not yet checked until a second competent user verifies it", () => {
  it.each(["transcribed", "reconciliation", "import"] as const)(
    "a new entry from %s is not yet checked",
    (origin) => {
      const result = transcribeMarEntry(draft(), TABLET_FACTS, {
        id: "entry-9",
        by: TRANSCRIBER,
        at: checkedAt,
        origin,
      });
      expect(result).toMatchObject({
        ok: true,
        entry: { state: "not_yet_checked", origin, version: 1, secondCheck: null },
      });
      if (result.ok)
        expect(marEntryStatus(result.entry, inForce, "give_with_notice").words).toBe(
          "Not yet checked",
        );
    },
  );

  it("a second person with current competence who compared it with the source checks it", () => {
    const e = checked();
    expect(e.state).toBe("checked");
    expect(e.secondCheck).toEqual({
      by: CHECKER,
      at: checkedAt,
      outcome: "matches_source",
      difference: null,
    });
    expect(marEntryStatus(e, inForce, "hold_until_checked")).toEqual({
      words: "Checked",
      mayGive: true,
      notice: null,
    });
  });

  it("a change is a new version, not yet checked, replacing the checked one from when it takes effect", () => {
    const old = checked();
    const startsAt = new Date("2026-11-05T12:00:00Z");
    const result = changeMarEntry(old, draft({ startsAt, directions: prn }), TABLET_FACTS, {
      id: "entry-2",
      by: CHECKER,
      at: new Date("2026-11-05T10:00:00Z"),
      origin: "transcribed",
    });
    if (!result.ok) throw new Error("change refused");
    expect(result.next).toMatchObject({
      id: "entry-2",
      version: 2,
      replacesId: old.id,
      state: "not_yet_checked",
      secondCheck: null,
    });
    expect(result.replaced).toMatchObject({
      state: "replaced",
      replacedById: "entry-2",
      replacedFrom: startsAt,
    });
    expect(marEntryEnd(result.replaced)).toEqual(startsAt);
    expect(marEntryDoses(result.replaced, day(5)).map((d) => formatUkTime(d.dueAt))).toEqual([
      "08:00",
    ]);
    expect(marEntryStatus(result.replaced, startsAt, "give_with_notice")).toEqual({
      words: "Replaced by a newer entry",
      mayGive: false,
      notice: null,
    });
    expect(
      marEntryStatus(result.replaced, new Date("2026-11-05T11:00:00Z"), "give_with_notice").notice,
    ).toBe("Replaced from 05/11/2026 12:00.");
  });

  it("by default an entry awaiting its check may be given, with the notice beside it (H-550)", () => {
    expect(marEntryStatus(entry(), inForce, "give_with_notice")).toEqual({
      words: "Not yet checked",
      mayGive: true,
      notice: MAR_ENTRY_NOTICES.notYetChecked,
    });
  });

  it("a tenant that holds unchecked entries sees why it may not be given", () => {
    expect(marEntryStatus(entry(), inForce, "hold_until_checked")).toEqual({
      words: "Not yet checked",
      mayGive: false,
      notice: MAR_ENTRY_NOTICES.holdUntilChecked,
    });
  });

  it("a check that finds a difference holds the entry until a corrected version replaces it", () => {
    const result = recordSecondCheck(entry(), {
      ...goodCheck,
      outcome: "differs_from_source",
      difference: "Letter says 1 tablet",
    });
    if (!result.ok) throw new Error("check refused");
    expect(result.entry.state).toBe("difference_found");
    expect(result.entry.secondCheck?.difference).toBe("Letter says 1 tablet");
    expect(marEntryStatus(result.entry, inForce, "give_with_notice")).toEqual({
      words: "Check found a difference",
      mayGive: false,
      notice: MAR_ENTRY_NOTICES.differenceFound,
    });
    const corrected = changeMarEntry(result.entry, draft({ startsAt: checkedAt }), TABLET_FACTS, {
      id: "entry-2",
      by: TRANSCRIBER,
      at: checkedAt,
      origin: "transcribed",
    });
    expect(corrected).toMatchObject({ ok: true, next: { state: "not_yet_checked", version: 2 } });
  });
});

describe("hazard HZ-005 the checker must be a different user from the transcriber", () => {
  it("refuses the transcriber as the checker", () => {
    expect(recordSecondCheck(entry(), { ...goodCheck, by: TRANSCRIBER })).toMatchObject({
      ok: false,
      issues: [{ problem: "checker_is_transcriber" }],
    });
  });

  it("refuses the person who made a change as the checker of that change, though they checked the earlier version", () => {
    const change = changeMarEntry(checked(), draft({ startsAt: checkedAt }), TABLET_FACTS, {
      id: "entry-2",
      by: CHECKER,
      at: checkedAt,
      origin: "transcribed",
    });
    if (!change.ok) throw new Error("change refused");
    expect(recordSecondCheck(change.next, goodCheck)).toMatchObject({
      ok: false,
      issues: [{ problem: "checker_is_transcriber" }],
    });
    expect(recordSecondCheck(change.next, { ...goodCheck, by: TRANSCRIBER })).toMatchObject({
      ok: true,
    });
  });

  it.each<[string, Partial<SecondCheckInput>, MarEntryProblem]>([
    ["expired medicines competence", { competence: "expired" }, "checker_not_competent"],
    ["no medicines competence", { competence: "not_held" }, "checker_not_competent"],
    ["no comparison with the source", { comparedWithSource: false }, "source_not_compared"],
    [
      "a difference with nothing said",
      { outcome: "differs_from_source", difference: " " },
      "difference_required",
    ],
  ])("refuses a check with %s", (_name, overrides, problem) => {
    expect(recordSecondCheck(entry(), { ...goodCheck, ...overrides })).toMatchObject({
      ok: false,
      issues: [{ problem }],
    });
  });

  it("refuses a second check of an entry that is not waiting for one", () => {
    expect(recordSecondCheck(checked(), goodCheck)).toMatchObject({
      ok: false,
      issues: [{ problem: "not_awaiting_check" }],
    });
  });
});

describe("stopping and changing an entry", () => {
  const stop = {
    by: CHECKER,
    at: new Date("2026-11-04T09:00:00Z"),
    effectiveAt: new Date("2026-11-04T12:00:00Z"),
    reason: "Stopped by the GP after review",
    source: { kind: "gp_record" as const, reference: "GP letter, 04/11/2026", documentId: null },
  };

  it("stops from the time given, keeping the doses before it", () => {
    const result = stopMarEntry(checked(), stop);
    if (!result.ok) throw new Error("stop refused");
    expect(result.entry.state).toBe("stopped");
    expect(marEntryDoses(result.entry, day(4)).map((d) => formatUkTime(d.dueAt))).toEqual([
      "08:00",
    ]);
    expect(marEntryStatus(result.entry, stop.at, "give_with_notice")).toEqual({
      words: "Checked",
      mayGive: true,
      notice: "Stops from 04/11/2026 12:00.",
    });
    expect(marEntryStatus(result.entry, stop.effectiveAt, "give_with_notice")).toEqual({
      words: "Stopped",
      mayGive: false,
      notice: null,
    });
  });

  it("keeps the not-yet-checked notice on an unchecked entry until its stop", () => {
    const result = stopMarEntry(entry(), stop);
    if (!result.ok) throw new Error("stop refused");
    expect(marEntryStatus(result.entry, stop.at, "give_with_notice").notice).toBe(
      `${MAR_ENTRY_NOTICES.notYetChecked} Stops from 04/11/2026 12:00.`,
    );
  });

  it.each<[string, Partial<typeof stop>, MarEntryProblem]>([
    ["no reason", { reason: "" }, "reason_required"],
    ["no source", { source: { ...stop.source, reference: "" } }, "source_required"],
    [
      "a stop dated before it was recorded",
      { effectiveAt: new Date("2026-11-04T08:00:00Z") },
      "stop_in_past",
    ],
  ])("refuses a stop with %s", (_name, overrides, problem) => {
    expect(stopMarEntry(checked(), { ...stop, ...overrides })).toMatchObject({
      ok: false,
      issues: [{ problem }],
    });
  });

  it("refuses to stop or change an entry already stopped or replaced", () => {
    const stopped = stopMarEntry(checked(), stop);
    if (!stopped.ok) throw new Error("stop refused");
    expect(stopMarEntry(stopped.entry, stop)).toMatchObject({
      ok: false,
      issues: [{ problem: "entry_closed" }],
    });
    const meta = { id: "entry-3", by: TRANSCRIBER, at: stop.at, origin: "transcribed" as const };
    expect(
      changeMarEntry(stopped.entry, draft({ startsAt: stop.at }), TABLET_FACTS, meta),
    ).toMatchObject({
      ok: false,
      issues: [{ problem: "entry_closed" }],
    });
  });

  it.each<[string, Partial<MarEntryDraft>, MarEntryProblem]>([
    [
      "for another person (HZ-001)",
      { personId: "person-other", startsAt: stop.at },
      "different_person",
    ],
    [
      "taking effect before it is recorded",
      { startsAt: new Date("2026-11-04T08:59:00Z") },
      "change_in_past",
    ],
    [
      "with a route dm+d does not give",
      { startsAt: stop.at, route: SUBCUTANEOUS },
      "route_not_permitted",
    ],
  ])("refuses a change %s", (_name, overrides, problem) => {
    const meta = { id: "entry-3", by: TRANSCRIBER, at: stop.at, origin: "transcribed" as const };
    expect(changeMarEntry(checked(), draft(overrides), TABLET_FACTS, meta)).toMatchObject({
      ok: false,
      issues: [{ problem }],
    });
  });

  it("ends the doses at the prescribed stop, and lists no doses for a when-required medicine", () => {
    const course = entry({ stopsAt: new Date("2026-11-03T12:00:00Z") });
    expect(marEntryDoses(course, { from: day(2).from, to: day(5).to }).map((d) => d.date)).toEqual([
      "2026-11-02",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(
      marEntryStatus(checked(course), new Date("2026-11-03T12:00:00Z"), "give_with_notice").words,
    ).toBe("Ended");
    expect(marEntryDoses(entry({ directions: prn }), day(2))).toEqual([]);
    expect(marEntryEnd(entry())).toBeNull();
  });

  it("keeps the person, product and route the entry was written for", () => {
    const e = entry();
    expect([e.personId, e.product, e.route, e.transcribedBy]).toEqual([
      PERSON,
      PRODUCT.paracetamolTablets,
      ORAL,
      TRANSCRIBER,
    ]);
  });
});

const every3 = (anchorOn: string): MarEntryDraft["directions"] => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "every_n_days", intervalDays: 3, anchorOn },
    times: [{ time: "08:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
  },
});
const fortnightly = (anchorOn: string): MarEntryDraft["directions"] => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "weekly", weekdays: ["mon"], intervalWeeks: 2, anchorOn },
    times: [{ time: "08:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
  },
});
const meta = (at: Date) => ({ id: "entry-2", by: TRANSCRIBER, at, origin: "transcribed" as const });
const datesOf = (entries: MarEntry[], from: number, to: number) =>
  entries.flatMap((e) =>
    marEntryDoses(e, { from: day(from).from, to: day(to).to }).map((d) => d.date),
  );

describe("hazard HZ-003 hazard HZ-004 a change keeps the day count of an every-n-days or fortnightly medicine", () => {
  const original = checked(entry({ directions: every3("2026-11-02") }));

  it.each([
    [7, 0],
    [9, 0],
  ])(
    "a dose every 3 days from Monday 02/11, changed at %i:%i on Tuesday 03/11, is next due on Thursday 05/11",
    (hour, minute) => {
      const at = fromUkWallClock(2026, 11, 3, hour, minute);
      const next = draft({ directions: every3("2026-11-02"), startsAt: at });
      const change = changeMarEntry(original, next, TABLET_FACTS, meta(at));
      if (!change.ok) throw new Error("change refused");
      expect(datesOf([change.replaced, change.next], 2, 9)).toEqual([
        "2026-11-02",
        "2026-11-05",
        "2026-11-08",
      ]);
      expect(change.next.reanchor).toBeNull();
    },
  );

  it("refuses a change that moves the count, unless the prescriber's new pattern starts a new count, which is recorded", () => {
    const at = fromUkWallClock(2026, 11, 3, 7, 0);
    const moved = draft({ directions: every3("2026-11-03"), startsAt: at });
    expect(changeMarEntry(original, moved, TABLET_FACTS, meta(at))).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
    const blankReason = { ...meta(at), reanchorReason: " " };
    expect(changeMarEntry(original, moved, TABLET_FACTS, blankReason)).toMatchObject({ ok: false });
    const reason = "GP letter 03/11: new patch applied today, then every 3 days";
    const change = changeMarEntry(original, moved, TABLET_FACTS, {
      ...meta(at),
      reanchorReason: reason,
    });
    if (!change.ok) throw new Error("change refused");
    expect(change.next.reanchor).toEqual({ by: TRANSCRIBER, at, reason });
    expect(datesOf([change.replaced, change.next], 2, 9)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-06",
      "2026-11-09",
    ]);
  });

  it("keeps a fortnightly count across a change, so the next dose is not a week late", () => {
    const monday = checked(entry({ directions: fortnightly("2026-11-02") }));
    const at = fromUkWallClock(2026, 11, 10, 9, 0);
    const kept = draft({ directions: fortnightly("2026-11-02"), startsAt: at });
    const change = changeMarEntry(monday, kept, TABLET_FACTS, meta(at));
    if (!change.ok) throw new Error("change refused");
    expect(datesOf([change.replaced, change.next], 2, 30)).toEqual([
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
    ]);
    const moved = draft({ directions: fortnightly("2026-11-09"), startsAt: at });
    expect(changeMarEntry(monday, moved, TABLET_FACTS, meta(at))).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
  });

  it("needs no reason when a daily medicine becomes every 3 days, or the count is kept", () => {
    const at = fromUkWallClock(2026, 11, 3, 9, 0);
    const fromDaily = draft({ directions: every3("2026-11-05"), startsAt: at });
    expect(changeMarEntry(checked(), fromDaily, TABLET_FACTS, meta(at))).toMatchObject({
      ok: true,
    });
    const sameCount = draft({ directions: every3("2026-11-08"), startsAt: at });
    expect(changeMarEntry(original, sameCount, TABLET_FACTS, meta(at))).toMatchObject({ ok: true });
  });
});

describe("hazard HZ-005 a future stop or replacement leaves the entry checkable while it is in force", () => {
  const now = new Date("2026-11-04T09:00:00Z");
  const check = { ...goodCheck, at: now };

  it("checks an unchecked entry whose stop is still to come, and holds it no longer", () => {
    const stopped = stopMarEntry(entry(), {
      by: CHECKER,
      at: now,
      effectiveAt: new Date("2026-11-11T12:00:00Z"),
      reason: "Course ends",
      source: SOURCE,
    });
    if (!stopped.ok) throw new Error("stop refused");
    expect(marEntryStatus(stopped.entry, now, "hold_until_checked").mayGive).toBe(false);
    const result = recordSecondCheck(stopped.entry, check);
    if (!result.ok) throw new Error("check refused");
    expect(result.entry).toMatchObject({ state: "stopped", secondCheck: { by: CHECKER } });
    expect(marEntryStatus(result.entry, now, "hold_until_checked")).toEqual({
      words: "Checked",
      mayGive: true,
      notice: "Stops from 11/11/2026 12:00.",
    });
  });

  it("checks an unchecked entry whose replacement starts next week", () => {
    const later = new Date("2026-11-11T00:00:00Z");
    const change = changeMarEntry(entry(), draft({ startsAt: later }), TABLET_FACTS, meta(now));
    if (!change.ok) throw new Error("change refused");
    const result = recordSecondCheck(change.replaced, check);
    expect(result).toMatchObject({
      ok: true,
      entry: { state: "replaced", secondCheck: { by: CHECKER } },
    });
    if (result.ok)
      expect(marEntryStatus(result.entry, now, "hold_until_checked").mayGive).toBe(true);
  });

  it("refuses a check once the entry has ended", () => {
    const ended = entry({ stopsAt: new Date("2026-11-03T00:00:00Z") });
    expect(recordSecondCheck(ended, check)).toMatchObject({
      ok: false,
      issues: [{ problem: "entry_ended" }],
    });
  });
});

describe("hazard HZ-004 only the version in force may be given", () => {
  it("a when-required medicine changed from tomorrow: today only the old version, tomorrow only the new", () => {
    const v1 = checked(entry({ directions: prn }));
    const tomorrow = new Date("2026-11-05T00:00:00Z");
    const changedAt = new Date("2026-11-04T10:00:00Z");
    const change = changeMarEntry(
      v1,
      draft({ directions: prn, startsAt: tomorrow }),
      TABLET_FACTS,
      meta(changedAt),
    );
    if (!change.ok) throw new Error("change refused");
    const today = new Date("2026-11-04T12:00:00Z");
    expect(marEntryStatus(change.replaced, today, "give_with_notice")).toMatchObject({
      mayGive: true,
      notice: "Replaced from 05/11/2026 00:00.",
    });
    expect(marEntryStatus(change.next, today, "give_with_notice")).toEqual({
      words: "Not started yet",
      mayGive: false,
      notice: "Starts 05/11/2026 00:00. Until then, give only from the entry in force.",
    });
    expect(marEntryStatus(change.replaced, tomorrow, "give_with_notice").mayGive).toBe(false);
    expect(marEntryStatus(change.next, tomorrow, "give_with_notice")).toMatchObject({
      words: "Not yet checked",
      mayGive: true,
    });
  });
});
