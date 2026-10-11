import { describe, expect, it } from "vitest";
import { tableSafetyRates } from "../../test/rate-table";
import { addUkDays } from "../shared/time";
import { detectOutbreaks, type InfectionCase } from "./outbreak";

/**
 * UKHSA outbreak detection at one location (safety.md rule 7). Hazard HZ-013. Thresholds come from
 * docs/specs/rates.md; tests build cases relative to them.
 */

const rates = tableSafetyRates();
const DAY1 = new Date("2026-10-05T09:00:00Z");

const ari = (ref: string, onsetAt: Date, o: Partial<InfectionCase> = {}): InfectionCase => ({
  ref,
  syndrome: "acute_respiratory",
  onsetAt,
  couldBeLinkedWithinSetting: true,
  ...o,
});
const dv = (ref: string, onsetAt: Date, link: InfectionCase["link"]): InfectionCase => ({
  ref,
  syndrome: "diarrhoea_vomiting",
  onsetAt,
  couldBeLinkedWithinSetting: null,
  link,
});

/** `count` ARI cases, the first on DAY1 and the last `spreadDays` later. */
function ariCases(count: number, spreadDays: number): InfectionCase[] {
  return Array.from({ length: count }, (_, i) =>
    ari(`case-${i + 1}`, addUkDays(DAY1, i === count - 1 ? spreadDays : 0)),
  );
}

describe("hazard HZ-013 the outbreak rule fires for linked cases within the configured window", () => {
  it.each<[string, InfectionCase[], boolean]>([
    [
      "the threshold of cases with onsets inside the window",
      ariCases(rates.ariCases, rates.ariWindowDays),
      true,
    ],
    [
      "the threshold of cases a day too far apart",
      ariCases(rates.ariCases, rates.ariWindowDays + 1),
      false,
    ],
    ["one case fewer than the threshold", ariCases(rates.ariCases - 1, 0), false],
    [
      "cases that could not have spread in the setting",
      ariCases(rates.ariCases, 0).map((c) => ({ ...c, couldBeLinkedWithinSetting: false })),
      false,
    ],
    [
      "cases where linkage is in doubt (report if in doubt)",
      ariCases(rates.ariCases, 0).map((c) => ({ ...c, couldBeLinkedWithinSetting: null })),
      true,
    ],
  ])("acute respiratory infection: %s", (_name, cases, expected) => {
    const signal = detectOutbreaks(cases, rates).signals.find(
      (s) => s.kind === "acute_respiratory",
    );
    expect(Boolean(signal)).toBe(expected);
  });

  it("starts the clock at the onset of the case that reached the threshold, using the earliest cluster", () => {
    const far = addUkDays(DAY1, rates.ariWindowDays * 3);
    const cases = [
      ari("early", DAY1),
      ...Array.from({ length: rates.ariCases }, (_, i) => ari(`late-${i}`, addUkDays(far, i))),
    ];
    const signal = detectOutbreaks(cases, rates).signals[0];
    expect(signal?.kind).toBe("acute_respiratory");
    expect(signal?.thresholdMetAt).toEqual(addUkDays(far, rates.ariCases - 1));
    expect(signal?.caseRefs).not.toContain("early");
    expect(signal?.sources[0]?.url).toMatch(
      /^https:\/\/www\.gov\.uk\/guidance\/report-an-outbreak/,
    );
  });

  it("counts UK calendar days across the October clock change", () => {
    const first = new Date("2026-10-24T22:30:00Z"); // 23:30 BST on Saturday 24 October
    const last = addUkDays(first, rates.ariWindowDays);
    const cases = [
      ari("a", first),
      ...Array.from({ length: rates.ariCases - 1 }, (_, i) => ari(`b${i}`, last)),
    ];
    expect(detectOutbreaks(cases, rates).signals).toHaveLength(1);
  });

  it("reports a single confirmed case of flu", () => {
    const confirmedAt = new Date("2026-10-06T15:00:00Z");
    const signals = detectOutbreaks(
      [ari("flu-1", DAY1, { fluConfirmedAt: confirmedAt })],
      rates,
    ).signals;
    const flu = signals.find((s) => s.kind === "flu");
    expect(Boolean(flu)).toBe(rates.fluConfirmedCases <= 1);
    if (flu) expect(flu.thresholdMetAt).toEqual(confirmedAt);
  });

  it("reaches the flu threshold at the earliest confirmation", () => {
    const first = new Date("2026-10-06T15:00:00Z");
    const second = new Date("2026-10-07T11:00:00Z");
    const flu = detectOutbreaks(
      [
        ari("flu-2", DAY1, { fluConfirmedAt: second }),
        ari("flu-1", DAY1, { fluConfirmedAt: first }),
      ],
      rates,
    ).signals.find((s) => s.kind === "flu");
    expect(flu?.caseRefs).toEqual(["flu-1", "flu-2"]);
    expect(flu?.reason).toMatch(/^2 confirmed cases of flu/);
  });

  it.each<[string, InfectionCase[], number]>([
    [
      "linked cases in one group",
      Array.from({ length: rates.diarrhoeaVomitingCases }, (_, i) =>
        dv(`dv-${i}`, addUkDays(DAY1, i), { group: "unit-a" }),
      ),
      1,
    ],
    [
      "cases in different groups",
      Array.from({ length: rates.diarrhoeaVomitingCases }, (_, i) =>
        dv(`dv-${i}`, DAY1, { group: `unit-${i}` }),
      ),
      0,
    ],
    [
      "cases staff decided are not linked",
      Array.from({ length: rates.diarrhoeaVomitingCases }, (_, i) =>
        dv(`dv-${i}`, DAY1, "not_linked"),
      ),
      0,
    ],
  ])("diarrhoea and vomiting: %s", (_name, cases, expected) => {
    expect(
      detectOutbreaks(cases, rates).signals.filter((s) => s.kind === "diarrhoea_vomiting"),
    ).toHaveLength(expected);
  });

  it("asks staff to review linkage once enough cases have not been reviewed", () => {
    const unreviewed = Array.from({ length: rates.diarrhoeaVomitingCases }, (_, i) =>
      dv(`dv-${i}`, DAY1, null),
    );
    expect(detectOutbreaks(unreviewed, rates).casesToReviewForLinks).toEqual(
      unreviewed.map((c) => c.ref),
    );
    expect(detectOutbreaks(unreviewed.slice(1), rates).casesToReviewForLinks).toEqual([]);
  });

  it("reads every threshold from the rates it is given", () => {
    const cases = ariCases(rates.ariCases, 0);
    expect(detectOutbreaks(cases, { ...rates, ariCases: rates.ariCases + 1 }).signals).toEqual([]);
  });

  it("orders signals by when each threshold was reached", () => {
    const cases = [
      ...ariCases(rates.ariCases, 0),
      ...Array.from({ length: rates.diarrhoeaVomitingCases }, (_, i) =>
        dv(`dv-${i}`, addUkDays(DAY1, -2), { group: "unit-a" }),
      ),
    ];
    expect(detectOutbreaks(cases, rates).signals.map((s) => s.kind)).toEqual([
      "diarrhoea_vomiting",
      "acute_respiratory",
    ]);
  });
});
