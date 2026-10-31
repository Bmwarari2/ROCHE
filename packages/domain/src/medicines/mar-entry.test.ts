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
import { formatUkTime, fromUkWallClock, ukEndOfDay, ukStartOfDay } from "../shared/time";
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
  transcribeMarEntry,
  versionInForceAt,
} from "./mar-entry";
import { expandSchedule, ukDateOf } from "./schedule";

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
    const startsAt = midnight(6);
    const result = changeMarEntry(
      [old],
      draft({ startsAt, directions: prn }),
      TABLET_FACTS,
      meta(at(5, 10)),
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
    expect(marEntryDoses(replaced, day(5)).map((d) => formatUkTime(d.dueAt))).toEqual([
      "08:00",
      "18:00",
    ]);
    expect(marEntryDoses(replaced, day(6))).toEqual([]);
    expect(marEntryStatus(replaced, startsAt, "give_with_notice")).toEqual({
      words: "Replaced by a newer entry",
      mayGive: false,
      notice: null,
    });
    expect(marEntryStatus(replaced, at(5, 11), "give_with_notice").notice).toBe(
      "Replaced from 06/11/2026 00:00.",
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
      draft({ startsAt: midnight(3) }),
      TABLET_FACTS,
      meta(inForce),
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
    const change = changeMarEntry([checked()], draft({ startsAt: midnight(3) }), TABLET_FACTS, {
      ...meta(inForce),
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

  it("refuses to stop or change a medicine once it has stopped", () => {
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
  });

  it("hazard HZ-004 a change before a stop keeps the stop; an earlier stop needs a reason to replace it", () => {
    const later = stopMarEntry([checked()], { ...stop, effectiveAt: at(6, 12) });
    if (!later.ok) throw new Error("stop refused");
    const versions = [later.stopped as MarEntry];
    const correction = changeMarEntry(versions, draft({ startsAt: midnight(5) }), TABLET_FACTS, {
      ...meta(stop.at),
    });
    expect(correction).toMatchObject({ ok: true, next: { stop: { effectiveAt: at(6, 12) } } });
    if (correction.ok) expect(marEntryEnd(correction.next)).toEqual(at(6, 12));
    expect(stopMarEntry(versions, stop)).toMatchObject({
      ok: false,
      issues: [{ problem: "later_version_scheduled" }],
    });
    expect(
      stopMarEntry(versions, stop, { withdrawLaterReason: "GP stopped it sooner" }),
    ).toMatchObject({ ok: true, stopped: { stop: { effectiveAt: stop.effectiveAt } } });
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
    [
      "into another product (a stop and a new entry)",
      { startsAt: midnight(5), product: PRODUCT.paracetamolCapsules },
      "different_product",
    ],
    [
      "part-way through a day with doses (rule 6c)",
      { startsAt: at(4, 10) },
      "change_from_tomorrow",
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
    const capsules = entry({ product: PRODUCT.paracetamolCapsules }, "entry-capsules");
    expect(stopMarEntry([entry(), capsules], stop)).toMatchObject({
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

  it("changes the brand within the same dm+d product (VMP)", () => {
    expect(
      changeMarEntry(
        [checked()],
        draft({ startsAt: midnight(5), product: PRODUCT.paracetamolBrandA }),
        TABLET_FACTS,
        meta(stop.at),
      ),
    ).toMatchObject({ ok: true, next: { product: PRODUCT.paracetamolBrandA } });
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
const daily = (...times: string[]): MarEntryDraft["directions"] => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "every_day" },
    times: times.map((time) => ({
      time,
      dose: { kind: "amount" as const, quantity: 1, unit: UNIT.tablet },
    })),
  },
});
/** Doses a day under regular directions every day; none when required. */
const perDay = (d: MarEntryDraft["directions"]) =>
  d.kind === "regular" ? d.schedule.times.length : 0;

describe("hazard HZ-004 exactly one version of a medicine is in force at any instant (rule 6b)", () => {
  it("refuses a change while a later version is scheduled, unless it withdraws that version and says why", () => {
    let versions: MarEntry[] = [checked(entry({ directions: daily("08:00") }))];
    versions = changed(
      versions,
      draft({ directions: daily("08:00"), startsAt: midnight(11) }),
      meta(at(4, 10)),
    );
    const v3 = draft({
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_day" },
          times: [{ time: "08:00", dose: { kind: "amount", quantity: 3, unit: UNIT.tablet } }],
        },
      },
      startsAt: midnight(5),
    });
    const m = { ...meta(at(4, 11)), id: "entry-3" };
    expect(changeMarEntry(versions, v3, TABLET_FACTS, m)).toMatchObject({
      ok: false,
      issues: [
        {
          problem: "later_version_scheduled",
          message:
            "Version 2 starts 11/11/2026 00:00. Change that version instead, or withdraw it here and say why.",
        },
      ],
    });
    const reason = "GP letter 04/11 replaces the change from 11/11";
    const result = changeMarEntry(versions, v3, TABLET_FACTS, {
      ...m,
      withdrawLaterReason: reason,
    });
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
    expect(result.replaced).toMatchObject({ id: "entry-1", replacedFrom: midnight(5) });
    expect(result.withdrawn).toMatchObject([
      { id: "entry-2", state: "withdrawn", withdrawn: { by: TRANSCRIBER, reason } },
    ]);
    versions = apply(versions, [result.replaced as MarEntry, ...result.withdrawn, result.next]);
    expect(givable(versions, at(6, 8)).map((v) => v.id)).toEqual(["entry-3"]);
    expect(givable(versions, at(12, 8)).map((v) => v.id)).toEqual(["entry-3"]);
    const v2 = versions.find((v) => v.id === "entry-2") as MarEntry;
    expect(marEntryStatus(v2, at(12, 8), "give_with_notice").words).toBe(
      "Withdrawn before it started",
    );
    expect(marEntryDoses(v2, day(12))).toEqual([]);
  });

  it("hazard HZ-005 correcting v1 while v2 and its stop are scheduled keeps the stop, so nothing is given after it", () => {
    let versions: MarEntry[] = [checked()];
    versions = changed(versions, draft({ startsAt: midnight(11) }), meta(at(4, 10)));
    const stop = stopMarEntry(versions, {
      by: CHECKER,
      at: at(5, 10),
      effectiveAt: midnight(15),
      reason: "Course ends",
      source: SOURCE,
    });
    if (!stop.ok) throw new Error("stop refused");
    expect(stop.stopped).toMatchObject({ id: "entry-2" });
    versions = apply(versions, [stop.stopped as MarEntry]);
    const correction = draft({ startsAt: midnight(7) });
    const m = { ...meta(at(6, 10)), id: "entry-3" };
    expect(changeMarEntry(versions, correction, TABLET_FACTS, m)).toMatchObject({
      ok: false,
      issues: [{ problem: "later_version_scheduled" }],
    });
    versions = changed(versions, correction, {
      ...m,
      withdrawLaterReason: "The correction replaces the dose change from 11/11",
    });
    expect(versions.find((v) => v.id === "entry-3")?.stop?.effectiveAt).toEqual(midnight(15));
    expect(givable(versions, at(20, 8))).toEqual([]);
    expect(datesOf(versions, 14, 16)).toEqual(["2026-11-14", "2026-11-14"]);
  });

  it("refuses a stop while a later version is scheduled, unless it withdraws that version and says why", () => {
    let versions: MarEntry[] = [checked()];
    versions = changed(versions, draft({ startsAt: midnight(11) }), meta(at(4, 10)));
    const stop: MarEntryStop = {
      by: CHECKER,
      at: at(5, 9),
      effectiveAt: at(6, 0),
      reason: "Stopped by the GP",
      source: SOURCE,
    };
    expect(stopMarEntry(versions, stop)).toMatchObject({
      ok: false,
      issues: [{ problem: "later_version_scheduled" }],
    });
    const why = "The GP stopped it before the change started";
    expect(stopMarEntry(versions, stop, { withdrawLaterReason: why })).toMatchObject({
      ok: true,
      stopped: { id: "entry-1" },
      withdrawn: [{ id: "entry-2", withdrawn: { by: CHECKER, reason: why } }],
    });
  });

  it("hazard HZ-005 never changes a medicine with no version in force, so a change cannot restart a stopped one", () => {
    const stopped = stopMarEntry([checked()], {
      by: CHECKER,
      at: at(2, 16),
      effectiveAt: midnight(6),
      reason: "Course ends",
      source: SOURCE,
    });
    if (!stopped.ok) throw new Error("stop refused");
    const restart = transcribeMarEntry(draft({ startsAt: midnight(14) }), TABLET_FACTS, {
      ...newMeta,
      id: "entry-restart",
      at: at(4, 2),
      earlierEntries: [stopped.stopped as MarEntry],
    });
    if (!restart.ok) throw new Error("restart refused");
    const versions = [stopped.stopped as MarEntry, restart.entry];
    expect(
      changeMarEntry(versions, draft({ startsAt: midnight(7) }), TABLET_FACTS, {
        ...meta(at(5, 6)),
        withdrawLaterReason: "Restart sooner",
      }),
    ).toMatchObject({ ok: false, issues: [{ problem: "entry_closed" }] });
    // Starting sooner is a stop that withdraws the restart, with the reason, then a new entry.
    const withdrawn = stopMarEntry(
      versions,
      {
        by: CHECKER,
        at: at(5, 6),
        effectiveAt: midnight(7),
        reason: "Restart sooner",
        source: SOURCE,
      },
      { withdrawLaterReason: "The GP restarts it from 07/11" },
    );
    expect(withdrawn).toMatchObject({
      ok: true,
      stopped: null,
      withdrawn: [{ id: "entry-restart", state: "withdrawn" }],
    });
  });

  it("hazard HZ-003 for any sequence of changes, stops, restarts and corrections: one version may be given, nothing after a stop, and each day's doses as its schedule says", () => {
    let seed = 20261031;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(options: readonly T[]): T =>
      options[Math.floor(random() * options.length)] as T;
    const HOUR = 3_600_000;
    const choices = [daily("08:00"), daily("20:00"), daily("08:00", "18:00"), prn];
    for (let run = 0; run < 40; run++) {
      let versions: MarEntry[] = [entry()];
      /** Each stop, and the step it was recorded at: it covers the entries recorded before it. */
      const stops: { effectiveAt: Date; step: number }[] = [];
      const recordedAtStep = new Map<string, number>([["entry-1", -1]]);
      let now = inForce.getTime();
      for (let step = 0; step < 8; step++) {
        now += Math.floor(random() * 36) * HOUR;
        const when = new Date(now);
        const anyHour = new Date(now + Math.floor(random() * 240) * HOUR);
        const takesEffect = random() < 0.5 ? anyHour : ukEndOfDay(ukDateOf(anyHour));
        const id = `v-${run}-${step}`;
        const withdrawLaterReason = random() < 0.5 ? "Replaced by the newer instruction" : null;
        const action = random();
        if (action < 0.4) {
          const current = versionInForceAt(versions, when);
          if (random() < 0.3 && current && current.secondCheck === null) {
            const differs = recordSecondCheck(current, {
              ...goodCheck,
              at: when,
              outcome: "differs_from_source",
              difference: "Dose differs from the letter",
            });
            if (differs.ok) versions = apply(versions, [differs.entry]);
          }
          const result = changeMarEntry(
            versions,
            draft({ directions: pick(choices), startsAt: takesEffect }),
            TABLET_FACTS,
            { ...meta(when), id, withdrawLaterReason },
          );
          if (result.ok)
            versions = apply(versions, [
              ...(result.replaced ? [result.replaced] : []),
              ...result.withdrawn,
              result.next,
            ]);
        } else if (action < 0.6) {
          const result = stopMarEntry(
            versions,
            { by: CHECKER, at: when, effectiveAt: takesEffect, reason: "Stopped", source: SOURCE },
            { withdrawLaterReason },
          );
          if (result.ok) {
            stops.push({ effectiveAt: takesEffect, step });
            versions = apply(versions, [
              ...(result.stopped ? [result.stopped] : []),
              ...result.withdrawn,
            ]);
          }
        } else if (action < 0.85) {
          const result = transcribeMarEntry(
            draft({ directions: pick(choices), startsAt: takesEffect }),
            TABLET_FACTS,
            { ...newMeta, id, at: when, earlierEntries: versions },
          );
          if (result.ok) {
            recordedAtStep.set(id, step);
            versions = [...versions, result.entry];
          }
        } else {
          const current = versionInForceAt(versions, when);
          if (current && current.secondCheck === null) {
            const result = recordSecondCheck(current, { ...goodCheck, at: when });
            if (result.ok) versions = apply(versions, [result.entry]);
          }
        }
      }
      const live = versions.filter((v) => v.withdrawn === null);
      const label = (when: Date) => `run ${run} at ${when.toISOString()}`;
      const byId = new Map(versions.map((v) => [v.id, v]));
      const entryOf = (v: MarEntry): MarEntry => {
        const earlier = v.replacesId === null ? undefined : byId.get(v.replacesId);
        return earlier ? entryOf(earlier) : v;
      };
      const afterStop = (v: MarEntry, t: number) =>
        stops.some(
          (stop) =>
            t >= stop.effectiveAt.getTime() &&
            (recordedAtStep.get(entryOf(v).id) ?? -1) < stop.step,
        );

      // At every instant a version starts or ends, and either side: at most one version may be
      // given, the one in force, and never one that started before a stop recorded by then.
      const instants = new Set<number>();
      for (const v of versions) {
        for (const edge of [v.startsAt, marEntryEnd(v)]) {
          if (!edge) continue;
          for (const shift of [-HOUR, -1, 0, 1, HOUR]) instants.add(edge.getTime() + shift);
        }
      }
      for (const t of instants) {
        const when = new Date(t);
        const ids = givable(versions, when);
        expect(ids.length, label(when)).toBeLessThanOrEqual(1);
        expect(
          ids.every((v) => v.id === versionInForceAt(versions, when)?.id),
          label(when),
        ).toBe(true);
        expect(
          ids.some((v) => afterStop(v, t)),
          label(when),
        ).toBe(false);
      }

      // Each day: doses only from the version in force; a day one version covers has exactly its
      // schedule's doses; a change part-way through a day has none that day under either version;
      // a restart part-way through a day follows no dose due earlier that day.
      for (let d = 2; d <= 45; d++) {
        const { from, to } = day(d);
        const inside = (x: Date | null) =>
          x !== null && x.getTime() > from.getTime() && x.getTime() < to.getTime();
        const doses = live.flatMap((v) =>
          marEntryDoses(v, { from, to }).map((dose) => ({ v, dose })),
        );
        for (const { v, dose } of doses) {
          expect(versionInForceAt(versions, dose.dueAt)?.id, label(dose.dueAt)).toBe(v.id);
          expect(afterStop(v, dose.dueAt.getTime()), label(dose.dueAt)).toBe(false);
        }
        if (!live.some((v) => inside(v.startsAt) || inside(marEntryEnd(v)))) {
          const whole = versionInForceAt(versions, from);
          const expected =
            whole?.directions.kind === "regular"
              ? expandSchedule(
                  whole.directions.schedule,
                  { startsAt: from, endsAt: null },
                  { from, to },
                )
              : [];
          expect(
            doses.map(({ dose }) => dose.dueAt.getTime()),
            label(from),
          ).toEqual(expected.map((x) => x.dueAt.getTime()));
        }
        for (const v of live) {
          if (v.replacedFrom && inside(v.replacedFrom)) {
            const next = live.find((n) => n.id === v.replacedById);
            expect(marEntryDoses(v, { from, to }), label(v.replacedFrom)).toEqual([]);
            if (next) expect(marEntryDoses(next, { from, to }), label(next.startsAt)).toEqual([]);
          }
          if (v.replacesId === null && inside(v.startsAt)) {
            const earlier = live
              .filter((e) => e.id !== v.id)
              .flatMap((e) => marEntryDoses(e, { from, to: v.startsAt }));
            expect(earlier, label(v.startsAt)).toEqual([]);
          }
        }
      }
    }
  }, 30_000);
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
    const moved = draft({ directions: every3("2026-11-04"), startsAt: midnight(4) });
    expect(changeMarEntry([original], moved, TABLET_FACTS, meta(when))).toMatchObject({
      ok: false,
      issues: [{ problem: "count_reanchored" }],
    });
    expect(
      changeMarEntry([original], moved, TABLET_FACTS, meta(when, { reanchorReason: " " })),
    ).toMatchObject({ ok: false });
    const reason = "GP letter 03/11: next patch on 04/11, then every 3 days";
    const versions = changed([original], moved, meta(when, { reanchorReason: reason }));
    expect(versions.find((v) => v.id === "entry-2")?.reanchor).toEqual({
      by: TRANSCRIBER,
      at: when,
      reason,
    });
    expect(datesOf(versions, 2, 9)).toEqual(["2026-11-02", "2026-11-04", "2026-11-07"]);
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
      expect(changeMarEntry([monday], tuesday, TABLET_FACTS, meta(when))).toMatchObject({
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
    const back = (anchorOn: string) =>
      draft({ directions: every3(anchorOn), startsAt: midnight(5) });
    const m = { ...meta(at(4, 9)), id: "entry-3" };
    expect(lastDueDose(versions, midnight(5))?.date).toBe("2026-11-04");
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
    const m = meta(at(3, 9));
    expect(
      changeMarEntry(
        [checked()],
        draft({ directions: every3("2026-11-05"), startsAt: midnight(4) }),
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
        draft({ directions: every3("2026-11-06"), startsAt: midnight(4) }),
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

describe("hazard HZ-003 hazard HZ-004 a change takes effect from 00:00 on a day with doses, so no dose that day is given twice or dropped (rule 6c)", () => {
  const morning = checked(entry({ directions: daily("08:00") }));
  const evening = checked(entry({ directions: daily("20:00") }));
  const twice = checked(entry({ directions: daily("08:00", "18:00") }));
  const whenRequired = checked(entry({ directions: prn }));

  it.each<[string, MarEntry, MarEntryDraft["directions"]]>([
    ["08:00 to 20:00 after the 08:00 dose (it would be given twice)", morning, daily("20:00")],
    ["20:00 to 08:00 before the 20:00 dose (it would be dropped)", evening, daily("08:00")],
    ["twice daily to 08:00 only, with the 18:00 dose still to come", twice, daily("08:00")],
    ["once daily to twice daily after the 08:00 dose", morning, daily("08:00", "18:00")],
    ["regular to when required on a day with doses", morning, prn],
    ["when required to regular, with a dose later that day", whenRequired, daily("20:00")],
  ])("refuses %s at 09:00, and takes it from 00:00 the next day", (_name, from, to) => {
    const when = at(5, 9);
    expect(
      changeMarEntry([from], draft({ directions: to, startsAt: when }), TABLET_FACTS, meta(when)),
    ).toMatchObject({ ok: false, issues: [{ problem: "change_from_tomorrow" }] });
    const versions = changed([from], draft({ directions: to, startsAt: midnight(6) }), meta(when));
    expect(datesOf(versions, 5, 5)).toHaveLength(perDay(from.directions));
    expect(datesOf(versions, 6, 6)).toHaveLength(perDay(to));
  });

  it("allows a change part-way through a day on which neither version has a dose", () => {
    const every3Entry = checked(entry({ directions: every3("2026-11-02") }));
    expect(
      changeMarEntry(
        [every3Entry],
        draft({ directions: every3("2026-11-02"), startsAt: at(3, 9) }),
        TABLET_FACTS,
        meta(at(3, 9)),
      ),
    ).toMatchObject({ ok: true });
    expect(
      changeMarEntry(
        [whenRequired],
        draft({ directions: prn, startsAt: at(3, 9) }),
        TABLET_FACTS,
        meta(at(3, 9)),
      ),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ["the clocks go back (25/10/2026)", 2026, 10, 25, ["01:30", "20:00"]],
    ["the clocks go forward (28/03/2027)", 2027, 3, 28, ["02:30", "20:00"]],
  ] as const)(
    "on the day %s, a change from 00:00 gives that day's doses as the new schedule does",
    (_name, year, month, date, times) => {
      const old = checked(
        entry({
          directions: daily("01:30", "08:00"),
          startsAt: fromUkWallClock(year, month, date - 5, 0, 0),
        }),
      );
      const iso = `${year}-${String(month).padStart(2, "0")}-${date}`;
      const dayBefore = fromUkWallClock(year, month, date - 1, 10, 0);
      const midday = fromUkWallClock(year, month, date, 12, 0);
      const next = draft({ directions: daily("01:30", "20:00"), startsAt: midday });
      expect(changeMarEntry([old], next, TABLET_FACTS, meta(dayBefore))).toMatchObject({
        ok: false,
        issues: [{ problem: "change_from_tomorrow" }],
      });
      const versions = changed([old], { ...next, startsAt: ukStartOfDay(iso) }, meta(dayBefore));
      const window = { from: ukStartOfDay(iso), to: ukEndOfDay(iso) };
      const doses = versions.flatMap((v) => marEntryDoses(v, window));
      expect(doses.map((d) => formatUkTime(d.dueAt))).toEqual(times);
      expect(doses.every((d) => d.date === iso)).toBe(true);
      const before = { from: ukStartOfDay(ukDateOf(dayBefore)), to: ukStartOfDay(iso) };
      expect(
        versions.flatMap((v) => marEntryDoses(v, before)).map((d) => formatUkTime(d.dueAt)),
      ).toEqual(["01:30", "08:00"]);
    },
  );
});

describe("hazard HZ-004 one entry of a dm+d product is in force for a person at a time", () => {
  const first = checked();
  const restartMeta = (when: Date, earlierEntries: MarEntry[]) => ({
    ...newMeta,
    id: "entry-new",
    at: when,
    earlierEntries,
  });

  it.each([
    ["the same product", PRODUCT.paracetamolTablets],
    ["another brand of it", PRODUCT.paracetamolBrandB],
  ])("refuses a second entry of %s while the first is in force", (_name, product) => {
    expect(
      transcribeMarEntry(
        draft({ product, directions: prn, startsAt: at(6, 9) }),
        TABLET_FACTS,
        restartMeta(at(6, 9), [first]),
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          problem: "same_product_in_force",
          message: `${product.name} is already on the MAR from 02/11/2026 00:00. Change that entry, or stop it first.`,
        },
      ],
    });
  });

  it("refuses one that would run into an entry recorded to start later", () => {
    const later = entry({ startsAt: midnight(10) });
    expect(
      transcribeMarEntry(
        draft({ startsAt: midnight(6) }),
        TABLET_FACTS,
        restartMeta(at(5, 9), [later]),
      ),
    ).toMatchObject({ ok: false, issues: [{ problem: "same_product_in_force" }] });
  });

  it("never matches by ingredient: paracetamol capsules are their own product", () => {
    expect(
      transcribeMarEntry(
        draft({ product: PRODUCT.paracetamolCapsules, startsAt: at(6, 9) }),
        TABLET_FACTS,
        restartMeta(at(6, 9), [first]),
      ),
    ).toMatchObject({ ok: true });
  });

  it("restarts the product once it has stopped, from the next day when a dose was due earlier that day", () => {
    const stop = (when: Date) =>
      stopMarEntry([checked()], {
        by: CHECKER,
        at: when,
        effectiveAt: when,
        reason: "Withheld until review",
        source: SOURCE,
      });
    const late = stop(at(6, 9));
    if (!late.ok) throw new Error("stop refused");
    const afterDose = [late.stopped as MarEntry];
    expect(
      transcribeMarEntry(
        draft({ startsAt: at(6, 10) }),
        TABLET_FACTS,
        restartMeta(at(6, 10), afterDose),
      ),
    ).toMatchObject({
      ok: false,
      issues: [
        {
          problem: "restart_from_tomorrow",
          message:
            "A dose was due at 08:00 that day under the entry that stopped. Start the new entry from 00:00 the next day, so no dose is given twice.",
        },
      ],
    });
    expect(
      transcribeMarEntry(
        draft({ startsAt: midnight(7) }),
        TABLET_FACTS,
        restartMeta(at(6, 10), afterDose),
      ),
    ).toMatchObject({ ok: true });
    const early = stop(at(6, 7));
    if (!early.ok) throw new Error("stop refused");
    const restarted = transcribeMarEntry(
      draft({ startsAt: at(6, 7, 30) }),
      TABLET_FACTS,
      restartMeta(at(6, 7, 30), [early.stopped as MarEntry]),
    );
    if (!restarted.ok) throw new Error("restart refused");
    expect(datesOf([early.stopped as MarEntry, restarted.entry], 6, 6)).toEqual([
      "2026-11-06",
      "2026-11-06",
    ]);
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
      draft({ startsAt: midnight(5) }),
      TABLET_FACTS,
      meta(now),
    );
    expect(corrected).toMatchObject({ ok: true, next: { stop: { effectiveAt: at(20, 12) } } });
    if (corrected.ok) expect(marEntryEnd(corrected.next)).toEqual(at(20, 12));
  });

  it("checks an unchecked entry whose replacement starts next week", () => {
    const change = changeMarEntry(
      [entry()],
      draft({ startsAt: midnight(11) }),
      TABLET_FACTS,
      meta(now),
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

describe("hazard HZ-005 no dose is given from a variable-dose entry until its dosing record exists (rule 2)", () => {
  const variable = () =>
    checked(
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

  it.each(["give_with_notice", "hold_until_checked"] as const)(
    "even checked, under %s",
    (policy) => {
      expect(marEntryStatus(variable(), inForce, policy)).toEqual({
        words: "Checked",
        mayGive: false,
        notice: MAR_ENTRY_NOTICES.variableDose,
      });
    },
  );

  it("tells staff what to do instead, and they can do it: stop the entry and record the day's dose as a new entry", () => {
    expect(MAR_ENTRY_NOTICES.variableDose).toContain(
      "Ask the prescriber for today's dose and record it as a new MAR entry",
    );
    const stopped = stopMarEntry([variable()], {
      by: CHECKER,
      at: at(5, 10),
      effectiveAt: at(5, 10),
      reason: "Today's dose from the anticoagulant clinic",
      source: SOURCE,
    });
    if (!stopped.ok) throw new Error("stop refused");
    const today = transcribeMarEntry(
      draft({
        product: PRODUCT.warfarin,
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [{ time: "18:00", dose: { kind: "amount", quantity: 3, unit: UNIT.mg } }],
          },
        },
        startsAt: at(5, 10),
        stopsAt: midnight(6),
      }),
      TABLET_FACTS,
      { ...newMeta, at: at(5, 10), earlierEntries: [stopped.stopped as MarEntry] },
    );
    if (!today.ok) throw new Error(today.issues.map((i) => i.message).join(" "));
    expect(marEntryDoses(today.entry, day(5)).map((d) => formatUkTime(d.dueAt))).toEqual(["18:00"]);
    expect(marEntryDoses(today.entry, day(6))).toEqual([]);
  });
});
