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
  type ChangeMeta,
  changeMarEntry,
  checkMarEntryDraft,
  lastDueDose,
  MAR_ENTRY_NOTICES,
  type MarEntry,
  type MarEntryDraft,
  type MarEntryProblem,
  type MarEntryStop,
  type MarSourceKind,
  marEntryDoses,
  marEntryEnd,
  marEntryStatus,
  recordSecondCheck,
  type SecondCheckInput,
  stopMarEntry,
  suggestedTags,
  type TenantMedicineLists,
  type TodaysDoses,
  transcribeMarEntry,
  versionInForceAt,
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
  maxQuantityPer24Hours: 8,
};
/** 00:00 UK time on a day of November 2026 (past the 30th it runs into December). */
const midnight = (d: number) => {
  const x = new Date(Date.UTC(2026, 10, d));
  return fromUkWallClock(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate(), 0, 0);
};
const day = (d: number) => ({ from: midnight(d), to: midnight(d + 1) });
const at = (d: number, hour: number, minute = 0) => fromUkWallClock(2026, 11, d, hour, minute);
const meta = (when: Date, extra: Partial<ChangeMeta> = {}): ChangeMeta => ({
  id: "entry-2",
  by: TRANSCRIBER,
  at: when,
  origin: "transcribed",
  ...extra,
});
const newMeta = {
  id: "e",
  by: TRANSCRIBER,
  at: checkedAt,
  origin: "transcribed" as const,
  earlierEntries: [],
};
/** A change that must succeed: the versions after it, in-force first. */
function changed(versions: MarEntry[], next: MarEntryDraft, m: ChangeMeta): MarEntry[] {
  const result = changeMarEntry(versions, next, TABLET_FACTS, m);
  if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
  return apply(versions, [
    ...(result.replaced ? [result.replaced] : []),
    ...result.withdrawn,
    result.next,
  ]);
}
function apply(versions: readonly MarEntry[], updates: readonly MarEntry[]): MarEntry[] {
  const byId = new Map(versions.map((v) => [v.id, v]));
  for (const u of updates) byId.set(u.id, u);
  return [...byId.values()];
}
const datesOf = (entries: readonly MarEntry[], from: number, to: number) =>
  entries
    .flatMap((e) => marEntryDoses(e, { from: day(from).from, to: day(to).to }))
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    .map((d) => d.date);
const givable = (versions: readonly MarEntry[], when: Date) =>
  versions.filter((v) => marEntryStatus(v, when, "give_with_notice").mayGive);

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
          maxQuantityPer24Hours: null,
        },
      },
      ["unit_not_permitted"],
    ],
    [
      "a 24-hour maximum that is not a number",
      { directions: { ...prn, maxQuantityPer24Hours: 0 } },
      ["bad_maximum"],
    ],
    [
      "a 24-hour maximum below one dose",
      { directions: { ...prn, maxQuantityPer24Hours: 1 } },
      ["maximum_below_dose"],
    ],
    ["a tag given twice", { tags: ["time_critical", "time_critical"] }, ["bad_tag"]],
    ["a tag not on the list", { tags: ["opioid" as "psychotropic"] }, ["bad_tag"]],
    [
      "a minimum interval in part minutes",
      { minimumIntervalMinutes: 30.5 },
      ["bad_minimum_interval"],
    ],
    ["a minimum interval of none", { minimumIntervalMinutes: 0 }, ["bad_minimum_interval"]],
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
    expect(transcribeMarEntry(draft({ prescriber: "" }), TABLET_FACTS, newMeta)).toMatchObject({
      ok: false,
    });
  });
});

describe("hazard HZ-005 a new or changed MAR entry stays not yet checked until a second competent user verifies it", () => {
  it.each(["transcribed", "reconciliation", "import"] as const)(
    "a new entry from %s is not yet checked",
    (origin) => {
      const result = transcribeMarEntry(draft(), TABLET_FACTS, {
        ...newMeta,
        id: "entry-9",
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
    const startsAt = at(5, 12);
    const result = changeMarEntry(
      [old],
      draft({ startsAt, directions: prn }),
      TABLET_FACTS,
      meta(at(5, 10), { todaysDoses: "all_given" }),
    );
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
    expect(result.next).toMatchObject({
      id: "entry-2",
      version: 2,
      replacesId: old.id,
      state: "not_yet_checked",
      secondCheck: null,
    });
    const replaced = result.replaced as MarEntry;
    expect(replaced).toMatchObject({
      state: "replaced",
      replacedById: "entry-2",
      replacedFrom: startsAt,
    });
    expect(marEntryEnd(replaced)).toEqual(startsAt);
    expect(marEntryDoses(replaced, day(5)).map((d) => formatUkTime(d.dueAt))).toEqual(["08:00"]);
    expect(marEntryStatus(replaced, startsAt, "give_with_notice")).toEqual({
      words: "Replaced by a newer entry",
      mayGive: false,
      notice: null,
    });
    expect(marEntryStatus(replaced, at(5, 11), "give_with_notice").notice).toBe(
      "Replaced from 05/11/2026 12:00.",
    );
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
    const corrected = changeMarEntry(
      [result.entry],
      draft({ startsAt: inForce }),
      TABLET_FACTS,
      meta(inForce, { todaysDoses: "some_still_due" }),
    );
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
    const change = changeMarEntry([checked()], draft({ startsAt: inForce }), TABLET_FACTS, {
      ...meta(inForce, { todaysDoses: "some_still_due" }),
      by: CHECKER,
    });
    if (!change.ok) throw new Error("change refused");
    const check = { ...goodCheck, at: inForce };
    expect(recordSecondCheck(change.next, check)).toMatchObject({
      ok: false,
      issues: [{ problem: "checker_is_transcriber" }],
    });
    expect(recordSecondCheck(change.next, { ...check, by: TRANSCRIBER })).toMatchObject({
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
  const stop: MarEntryStop = {
    by: CHECKER,
    at: at(4, 9),
    effectiveAt: at(4, 12),
    reason: "Stopped by the GP after review",
    source: { kind: "gp_record", reference: "GP letter, 04/11/2026", documentId: null },
  };

  it("stops from the time given, keeping the doses before it", () => {
    const result = stopMarEntry([checked()], stop);
    if (!result.ok) throw new Error("stop refused");
    const stopped = result.stopped as MarEntry;
    expect(stopped.state).toBe("stopped");
    expect(marEntryDoses(stopped, day(4)).map((d) => formatUkTime(d.dueAt))).toEqual(["08:00"]);
    expect(marEntryStatus(stopped, stop.at, "give_with_notice")).toEqual({
      words: "Checked",
      mayGive: true,
      notice: "Stops from 04/11/2026 12:00.",
    });
    expect(marEntryStatus(stopped, stop.effectiveAt, "give_with_notice")).toEqual({
      words: "Stopped",
      mayGive: false,
      notice: null,
    });
  });

  it("keeps the not-yet-checked notice on an unchecked entry until its stop", () => {
    const result = stopMarEntry([entry()], stop);
    if (!result.ok) throw new Error("stop refused");
    expect(marEntryStatus(result.stopped as MarEntry, stop.at, "give_with_notice").notice).toBe(
      `${MAR_ENTRY_NOTICES.notYetChecked} Stops from 04/11/2026 12:00.`,
    );
  });

  it.each<[string, Partial<MarEntryStop>, MarEntryProblem]>([
    ["no reason", { reason: "" }, "reason_required"],
    ["no source", { source: { ...stop.source, reference: "" } }, "source_required"],
    ["a stop dated before it was recorded", { effectiveAt: at(4, 8) }, "stop_in_past"],
  ])("refuses a stop with %s", (_name, overrides, problem) => {
    expect(stopMarEntry([checked()], { ...stop, ...overrides })).toMatchObject({
      ok: false,
      issues: [{ problem }],
    });
  });

  it("refuses to stop or change a medicine once it has stopped, but not before", () => {
    const result = stopMarEntry([checked()], stop);
    if (!result.ok) throw new Error("stop refused");
    const versions = [result.stopped as MarEntry];
    expect(stopMarEntry(versions, stop)).toMatchObject({
      ok: false,
      issues: [{ problem: "entry_closed" }],
    });
    expect(
      changeMarEntry(versions, draft({ startsAt: at(4, 13) }), TABLET_FACTS, meta(stop.at)),
    ).toMatchObject({
      ok: false,
      issues: [{ problem: "entry_closed" }],
    });
    // Before the stop takes effect a correction is allowed, and the stop carries over to it.
    const correction = changeMarEntry(
      versions,
      draft({ startsAt: at(4, 10) }),
      TABLET_FACTS,
      meta(stop.at, { todaysDoses: "all_given" }),
    );
    expect(correction).toMatchObject({
      ok: true,
      next: { stop: { effectiveAt: stop.effectiveAt } },
    });
  });

  it.each<[string, Partial<MarEntryDraft>, MarEntryProblem]>([
    [
      "for another person (HZ-001)",
      { personId: "person-other", startsAt: stop.at },
      "different_person",
    ],
    ["taking effect before it is recorded", { startsAt: at(4, 8, 59) }, "change_in_past"],
    [
      "with a route dm+d does not give",
      { startsAt: stop.at, route: SUBCUTANEOUS },
      "route_not_permitted",
    ],
  ])("refuses a change %s", (_name, overrides, problem) => {
    expect(
      changeMarEntry([checked()], draft(overrides), TABLET_FACTS, meta(stop.at)),
    ).toMatchObject({ ok: false, issues: [{ problem }] });
  });

  it("refuses versions that are not one medicine for one person", () => {
    const other = entry({ personId: "person-other" }, "entry-other");
    expect(changeMarEntry([], draft(), TABLET_FACTS, meta(inForce))).toMatchObject({
      ok: false,
      issues: [{ problem: "not_one_medicine" }],
    });
    expect(changeMarEntry([entry(), other], draft(), TABLET_FACTS, meta(inForce))).toMatchObject({
      ok: false,
      issues: [{ problem: "not_one_medicine" }],
    });
    expect(stopMarEntry([], stop)).toMatchObject({
      ok: false,
      issues: [{ problem: "not_one_medicine" }],
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

describe("hazard HZ-004 exactly one version of a medicine is in force at any instant (rule 6b)", () => {
  it("v1 changed to v2 from 11/11, then v2 changed to v3 from 05/11: v1 ends on 05/11 and v2 is withdrawn", () => {
    const oneTablet = (time: string) => ({
      kind: "regular" as const,
      schedule: {
        pattern: { kind: "every_day" as const },
        times: [{ time, dose: { kind: "amount" as const, quantity: 1, unit: UNIT.tablet } }],
      },
    });
    let versions: MarEntry[] = [checked(entry({ directions: oneTablet("08:00") }))];
    versions = changed(
      versions,
      draft({ directions: oneTablet("08:00"), startsAt: midnight(11) }),
      meta(at(4, 10), { todaysDoses: "some_still_due" }),
    );
    const v3 = draft({
      directions: {
        ...oneTablet("08:00"),
        schedule: {
          ...oneTablet("08:00").schedule,
          times: [{ time: "08:00", dose: { kind: "amount", quantity: 3, unit: UNIT.tablet } }],
        },
      },
      startsAt: at(5, 9),
    });
    const result = changeMarEntry(versions, v3, TABLET_FACTS, {
      ...meta(at(5, 9), { todaysDoses: "all_given" }),
      id: "entry-3",
    });
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
    expect(result.replaced).toMatchObject({ id: "entry-1", replacedFrom: at(5, 9) });
    expect(result.withdrawn).toMatchObject([
      {
        id: "entry-2",
        state: "withdrawn",
        withdrawn: { by: TRANSCRIBER, reason: "Replaced before it started by version 3" },
      },
    ]);
    versions = apply(versions, [result.replaced as MarEntry, ...result.withdrawn, result.next]);
    expect(givable(versions, at(6, 8)).map((v) => v.id)).toEqual(["entry-3"]);
    expect(givable(versions, at(12, 8)).map((v) => v.id)).toEqual(["entry-3"]);
    expect(
      marEntryStatus(
        versions.find((v) => v.id === "entry-2") as MarEntry,
        at(12, 8),
        "give_with_notice",
      ).words,
    ).toBe("Withdrawn before it started");
    expect(marEntryDoses(versions.find((v) => v.id === "entry-2") as MarEntry, day(12))).toEqual(
      [],
    );
  });

  it("a stop withdraws a version that had not started", () => {
    let versions: MarEntry[] = [checked()];
    versions = changed(
      versions,
      draft({ startsAt: midnight(11) }),
      meta(at(4, 10), { todaysDoses: "some_still_due" }),
    );
    const result = stopMarEntry(versions, {
      by: CHECKER,
      at: at(5, 9),
      effectiveAt: at(6, 0),
      reason: "Stopped by the GP",
      source: SOURCE,
    });
    expect(result).toMatchObject({
      ok: true,
      stopped: { id: "entry-1" },
      withdrawn: [{ id: "entry-2", withdrawn: { reason: "Stopped before it started" } }],
    });
  });

  it("for any sequence of changes and stops, no instant has two versions that may be given", () => {
    let seed = 20261031;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 60; run++) {
      let versions: MarEntry[] = [entry()];
      let now = inForce.getTime();
      for (let step = 0; step < 6; step++) {
        now += Math.floor(random() * 36) * 3_600_000;
        const takesEffect = new Date(now + Math.floor(random() * 240) * 3_600_000);
        if (random() < 0.8) {
          for (const todaysDoses of ["some_still_due", "all_given"] as TodaysDoses[]) {
            const result = changeMarEntry(
              versions,
              draft({ startsAt: takesEffect }),
              TABLET_FACTS,
              {
                ...meta(new Date(now), { todaysDoses }),
                id: `v-${run}-${step}`,
              },
            );
            if (result.ok) {
              versions = apply(versions, [
                ...(result.replaced ? [result.replaced] : []),
                ...result.withdrawn,
                result.next,
              ]);
              break;
            }
          }
        } else {
          const result = stopMarEntry(versions, {
            by: CHECKER,
            at: new Date(now),
            effectiveAt: takesEffect,
            reason: "Stopped",
            source: SOURCE,
          });
          if (result.ok)
            versions = apply(versions, [
              ...(result.stopped ? [result.stopped] : []),
              ...result.withdrawn,
            ]);
        }
      }
      // Every hour boundary where a version can start or end, and the hours either side of each.
      const instants = new Set<number>();
      for (const v of versions) {
        for (const edge of [v.startsAt, marEntryEnd(v)]) {
          if (!edge) continue;
          for (const shift of [-3_600_000, -1, 0, 1, 3_600_000])
            instants.add(edge.getTime() + shift);
        }
      }
      for (const t of instants) {
        const when = new Date(t);
        const ids = givable(versions, when).map((v) => v.id);
        expect(ids.length, `run ${run} at ${when.toISOString()}`).toBeLessThanOrEqual(1);
        expect(ids.every((id) => id === versionInForceAt(versions, when)?.id)).toBe(true);
      }
    }
  }, 30_000);
});

const every3 = (anchorOn: string): MarEntryDraft["directions"] => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "every_n_days", intervalDays: 3, anchorOn },
    times: [{ time: "08:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
  },
});
const weekly = (
  weekdays: ("mon" | "tue")[],
  intervalWeeks: number,
  anchorOn: string,
): MarEntryDraft["directions"] => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "weekly", weekdays, intervalWeeks, anchorOn },
    times: [{ time: "08:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
  },
});
const daily = (time: string): MarEntryDraft["directions"] => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "every_day" },
    times: [{ time, dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
  },
});

describe("hazard HZ-003 hazard HZ-004 a change keeps the day count of an every-n-days or fortnightly medicine", () => {
  const original = checked(entry({ directions: every3("2026-11-02") }));

  it.each([
    [7, 0],
    [9, 0],
  ])(
    "a dose every 3 days from Monday 02/11, changed at %i:%i on Tuesday 03/11, is next due on Thursday 05/11",
    (hour, minute) => {
      const when = at(3, hour, minute);
      const versions = changed(
        [original],
        draft({ directions: every3("2026-11-02"), startsAt: when }),
        meta(when),
      );
      expect(datesOf(versions, 2, 9)).toEqual(["2026-11-02", "2026-11-05", "2026-11-08"]);
      expect(versions.find((v) => v.id === "entry-2")?.reanchor).toBeNull();
    },
  );

  it("refuses a change that moves the count, unless the prescriber's new pattern starts a new count, which is recorded", () => {
    const when = at(3, 7);
    const moved = draft({ directions: every3("2026-11-03"), startsAt: when });
    expect(
      changeMarEntry(
        [original],
        moved,
        TABLET_FACTS,
        meta(when, { todaysDoses: "some_still_due" }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
    expect(
      changeMarEntry(
        [original],
        moved,
        TABLET_FACTS,
        meta(when, { todaysDoses: "some_still_due", reanchorReason: " " }),
      ),
    ).toMatchObject({ ok: false });
    const reason = "GP letter 03/11: new patch applied today, then every 3 days";
    const versions = changed(
      [original],
      moved,
      meta(when, { todaysDoses: "some_still_due", reanchorReason: reason }),
    );
    expect(versions.find((v) => v.id === "entry-2")?.reanchor).toEqual({
      by: TRANSCRIBER,
      at: when,
      reason,
    });
    expect(datesOf(versions, 2, 9)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-06",
      "2026-11-09",
    ]);
  });

  it("keeps a fortnightly count across a change, so the next dose is not a week late", () => {
    const monday = checked(entry({ directions: weekly(["mon"], 2, "2026-11-02") }));
    const when = at(10, 9);
    const versions = changed(
      [monday],
      draft({ directions: weekly(["mon"], 2, "2026-11-02"), startsAt: when }),
      meta(when),
    );
    expect(datesOf(versions, 2, 30)).toEqual(["2026-11-02", "2026-11-16", "2026-11-30"]);
    const moved = draft({ directions: weekly(["mon"], 2, "2026-11-09"), startsAt: when });
    expect(changeMarEntry([monday], moved, TABLET_FACTS, meta(when))).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
  });

  it.each([
    ["fortnightly", 2],
    ["weekly", 1],
  ] as const)(
    "treats moving a %s Monday dose to Tuesday as a new count that needs a reason",
    (_name, intervalWeeks) => {
      const monday = checked(entry({ directions: weekly(["mon"], intervalWeeks, "2026-11-02") }));
      const when = at(2, 12);
      const tuesday = draft({
        directions: weekly(["tue"], intervalWeeks, "2026-11-02"),
        startsAt: when,
      });
      expect(
        changeMarEntry([monday], tuesday, TABLET_FACTS, meta(when, { todaysDoses: "all_given" })),
      ).toMatchObject({
        ok: false,
        issues: [{ problem: "count_reanchored" }],
      });
    },
  );

  it("compares with the last dose actually due, through a change to every day and back", () => {
    let versions = changed(
      [original],
      draft({ directions: daily("08:00"), startsAt: at(3, 9) }),
      meta(at(3, 9)),
    );
    const back = (anchorOn: string) => draft({ directions: every3(anchorOn), startsAt: at(4, 9) });
    const m = { ...meta(at(4, 9), { todaysDoses: "all_given" as const }), id: "entry-3" };
    expect(lastDueDose(versions, at(4, 9))?.date).toBe("2026-11-04");
    expect(changeMarEntry(versions, back("2026-11-08"), TABLET_FACTS, m)).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
    versions = changed(versions, back("2026-11-07"), m);
    expect(datesOf(versions, 2, 10)).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-07",
      "2026-11-10",
    ]);
  });

  it("keeps the count when the same product is stopped and started again", () => {
    const stopped = stopMarEntry([original], {
      by: CHECKER,
      at: at(6, 9),
      effectiveAt: at(6, 9),
      reason: "Withheld until review",
      source: SOURCE,
    });
    if (!stopped.ok) throw new Error("stop refused");
    const earlierEntries = [stopped.stopped as MarEntry];
    const restart = (anchorOn: string) =>
      draft({ directions: every3(anchorOn), startsAt: at(7, 9) });
    const m = { ...newMeta, id: "entry-new", at: at(7, 9), earlierEntries };
    expect(transcribeMarEntry(restart("2026-11-07"), TABLET_FACTS, m)).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
    expect(transcribeMarEntry(restart("2026-11-08"), TABLET_FACTS, m)).toMatchObject({ ok: true });
    expect(
      transcribeMarEntry(restart("2026-11-07"), TABLET_FACTS, {
        ...m,
        reanchorReason: "Review: restart today",
      }),
    ).toMatchObject({
      ok: true,
      entry: { reanchor: { reason: "Review: restart today" } },
    });
    const otherProduct = draft({
      directions: every3("2026-11-07"),
      startsAt: at(7, 9),
      product: PRODUCT.warfarin,
    });
    expect(transcribeMarEntry(otherProduct, TABLET_FACTS, m)).toMatchObject({ ok: true });
  });

  it("needs a reason when a daily medicine becomes every 3 days off the last daily dose, and none on it", () => {
    const when = at(3, 9);
    const m = meta(when, { todaysDoses: "all_given" });
    expect(
      changeMarEntry(
        [checked()],
        draft({ directions: every3("2026-11-05"), startsAt: when }),
        TABLET_FACTS,
        m,
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
    expect(
      changeMarEntry(
        [checked()],
        draft({ directions: every3("2026-11-06"), startsAt: when }),
        TABLET_FACTS,
        m,
      ),
    ).toMatchObject({ ok: true });
  });

  it("refuses a change with no anchor rather than throwing", () => {
    const noAnchor = {
      kind: "regular",
      schedule: {
        pattern: { kind: "every_n_days", intervalDays: 3 },
        times: [{ time: "08:00", dose: { kind: "amount", quantity: 1, unit: UNIT.tablet } }],
      },
    } as unknown as MarEntryDraft["directions"];
    const result = changeMarEntry(
      [original],
      draft({ directions: noAnchor, startsAt: at(3, 9) }),
      TABLET_FACTS,
      meta(at(3, 9)),
    );
    expect(result.ok ? [] : result.issues.map((i) => i.problem)).toEqual(["bad_anchor"]);
  });
});

describe("hazard HZ-003 hazard HZ-004 a change on a day with doses says what happened to that day's doses (rule 6c)", () => {
  const morning = checked(entry({ directions: daily("08:00") }));
  const evening = checked(entry({ directions: daily("20:00") }));

  it("08:00 to 20:00 at 09:00 on Thursday 05/11: asks, and gives one dose that day when it was given", () => {
    const when = at(5, 9);
    const toEvening = draft({ directions: daily("20:00"), startsAt: when });
    expect(changeMarEntry([morning], toEvening, TABLET_FACTS, meta(when))).toMatchObject({
      ok: false,
      issues: [{ problem: "todays_doses_unstated" }],
    });
    const given = changed([morning], toEvening, meta(when, { todaysDoses: "all_given" }));
    expect(datesOf(given, 5, 6)).toEqual(["2026-11-05", "2026-11-06"]);
    const stillDue = changed([morning], toEvening, meta(when, { todaysDoses: "some_still_due" }));
    expect(datesOf(stillDue, 5, 5)).toEqual(["2026-11-05", "2026-11-05"]);
  });

  it("20:00 to 08:00 at 09:00: never drops that day's dose without saying so", () => {
    const when = at(5, 9);
    const toMorning = draft({ directions: daily("08:00"), startsAt: when });
    expect(
      changeMarEntry(
        [evening],
        toMorning,
        TABLET_FACTS,
        meta(when, { todaysDoses: "some_still_due" }),
      ),
    ).toMatchObject({
      ok: false,
      issues: [{ problem: "no_dose_left_today" }],
    });
    expect(
      changeMarEntry([evening], toMorning, TABLET_FACTS, meta(when, { todaysDoses: "all_given" })),
    ).toMatchObject({
      ok: false,
      issues: [{ problem: "nothing_given_yet" }],
    });
    const tomorrow = changed(
      [evening],
      draft({ directions: daily("08:00"), startsAt: midnight(6) }),
      meta(when, { todaysDoses: "some_still_due" }),
    );
    expect(datesOf(tomorrow, 5, 6)).toEqual(["2026-11-05", "2026-11-06"]);
  });

  it("asks nothing on a day with no doses", () => {
    const every3Entry = checked(entry({ directions: every3("2026-11-02") }));
    expect(
      changeMarEntry(
        [every3Entry],
        draft({ directions: every3("2026-11-02"), startsAt: at(3, 9) }),
        TABLET_FACTS,
        meta(at(3, 9)),
      ),
    ).toMatchObject({
      ok: true,
      next: { changeDay: null },
    });
  });
});

describe("hazard HZ-005 a future stop or replacement leaves the entry checkable and correctable while it is in force", () => {
  const now = at(4, 9);
  const check = { ...goodCheck, at: now };
  const laterStop: MarEntryStop = {
    by: CHECKER,
    at: now,
    effectiveAt: at(20, 12),
    reason: "Course ends",
    source: SOURCE,
  };

  it("checks an unchecked entry whose stop is still to come, and holds it no longer", () => {
    const stopped = stopMarEntry([entry()], laterStop);
    if (!stopped.ok) throw new Error("stop refused");
    const e = stopped.stopped as MarEntry;
    expect(marEntryStatus(e, now, "hold_until_checked").mayGive).toBe(false);
    const result = recordSecondCheck(e, check);
    if (!result.ok) throw new Error("check refused");
    expect(result.entry).toMatchObject({ state: "stopped", secondCheck: { by: CHECKER } });
    expect(marEntryStatus(result.entry, now, "hold_until_checked")).toEqual({
      words: "Checked",
      mayGive: true,
      notice: "Stops from 20/11/2026 12:00.",
    });
  });

  it("corrects an entry whose stop is still to come after its check found a difference, carrying the stop over", () => {
    const stopped = stopMarEntry([entry()], laterStop);
    if (!stopped.ok) throw new Error("stop refused");
    const differs = recordSecondCheck(stopped.stopped as MarEntry, {
      ...check,
      outcome: "differs_from_source",
      difference: "1 tablet, not 2",
    });
    if (!differs.ok) throw new Error("check refused");
    const corrected = changeMarEntry(
      [differs.entry],
      draft({ startsAt: at(4, 10) }),
      TABLET_FACTS,
      meta(now, { todaysDoses: "some_still_due" }),
    );
    expect(corrected).toMatchObject({ ok: true, next: { stop: { effectiveAt: at(20, 12) } } });
    if (corrected.ok) expect(marEntryEnd(corrected.next)).toEqual(at(20, 12));
  });

  it("checks an unchecked entry whose replacement starts next week", () => {
    const change = changeMarEntry(
      [entry()],
      draft({ startsAt: midnight(11) }),
      TABLET_FACTS,
      meta(now, { todaysDoses: "some_still_due" }),
    );
    if (!change.ok) throw new Error("change refused");
    const result = recordSecondCheck(change.replaced as MarEntry, check);
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
    const tomorrow = midnight(5);
    const change = changeMarEntry(
      [v1],
      draft({ directions: prn, startsAt: tomorrow }),
      TABLET_FACTS,
      meta(at(4, 10)),
    );
    if (!change.ok) throw new Error("change refused");
    const replaced = change.replaced as MarEntry;
    const today = at(4, 12);
    expect(marEntryStatus(replaced, today, "give_with_notice")).toMatchObject({
      mayGive: true,
      notice: "Replaced from 05/11/2026 00:00.",
    });
    expect(marEntryStatus(change.next, today, "give_with_notice")).toEqual({
      words: "Not started yet",
      mayGive: false,
      notice: "Starts 05/11/2026 00:00. Until then, give only from the entry in force.",
    });
    expect(marEntryStatus(replaced, tomorrow, "give_with_notice").mayGive).toBe(false);
    expect(marEntryStatus(change.next, tomorrow, "give_with_notice")).toMatchObject({
      words: "Not yet checked",
      mayGive: true,
    });
  });
});

describe("hazard HZ-005 a variable-dose entry says its dose comes from the checked dosing record (rule 18)", () => {
  // The refusal of a dose without a checked dosing record is `checkAdministration`'s
  // (administration.test.ts, `hazard HZ-005 a variable dose is given only from a checked dosing record`).
  it.each(["give_with_notice", "hold_until_checked"] as const)("checked, under %s", (policy) => {
    const variable = checked(
      entry({
        product: PRODUCT.warfarin,
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [{ time: "18:00", dose: { kind: "variable", unit: UNIT.mg } }],
          },
        },
      }),
    );
    expect(marEntryStatus(variable, inForce, policy)).toEqual({
      words: "Checked",
      mayGive: true,
      notice: MAR_ENTRY_NOTICES.variableDose,
    });
  });
});

describe("ADR-0082 tags come from a person at transcription, offered only from the tenant's own lists", () => {
  const lists: TenantMedicineLists = {
    time_critical: new Set([PRODUCT.levothyroxine.vmpId]),
    paracetamol: new Set([PRODUCT.paracetamolTablets.vmpId]),
    bisphosphonate: new Set([PRODUCT.alendronicAcid.vmpId]),
    psychotropic: new Set(),
  };

  it("offers a tag only when the tenant's list holds the product's exact VMP", () => {
    expect(suggestedTags(PRODUCT.paracetamolTablets, lists)).toEqual(["paracetamol"]);
    expect(suggestedTags(PRODUCT.paracetamolBrandA, lists)).toEqual(["paracetamol"]);
    expect(suggestedTags(PRODUCT.alendronicAcid, lists)).toEqual(["bisphosphonate"]);
  });

  it("never offers one by ingredient or name: another VMP with the same ingredient gets none", () => {
    expect(suggestedTags(PRODUCT.paracetamolCapsules, lists)).toEqual([]);
    expect(suggestedTags(PRODUCT.warfarin, lists)).toEqual([]);
  });

  it("a tag is part of the entry, so changing it is a new version a second person checks", () => {
    const tagged = draft({ tags: ["time_critical"], startsAt: at(2, 12) });
    const change = changeMarEntry(
      [checked()],
      tagged,
      TABLET_FACTS,
      meta(at(2, 12), { todaysDoses: "some_still_due" }),
    );
    expect(change).toMatchObject({
      ok: true,
      next: { tags: ["time_critical"], state: "not_yet_checked" },
    });
  });
});
