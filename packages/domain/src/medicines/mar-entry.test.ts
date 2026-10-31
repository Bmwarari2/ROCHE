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
const day = (d: number) => ({
  from: fromUkWallClock(2026, 11, d, 0, 0),
  to: fromUkWallClock(2026, 11, d + 1, 0, 0),
});

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
        expect(marEntryStatus(result.entry, checkedAt, "give_with_notice").words).toBe(
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
    expect(marEntryStatus(e, checkedAt, "hold_until_checked")).toEqual({
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
    expect(marEntryStatus(entry(), checkedAt, "give_with_notice")).toEqual({
      words: "Not yet checked",
      mayGive: true,
      notice: MAR_ENTRY_NOTICES.notYetChecked,
    });
  });

  it("a tenant that holds unchecked entries sees why it may not be given", () => {
    expect(marEntryStatus(entry(), checkedAt, "hold_until_checked")).toEqual({
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
    expect(marEntryStatus(result.entry, checkedAt, "give_with_notice")).toEqual({
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
