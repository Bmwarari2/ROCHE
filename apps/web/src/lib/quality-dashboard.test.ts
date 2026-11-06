import type { QualityIndicatorOut } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  countWords,
  endedMonths,
  figureWords,
  pirAnswer,
  pirChip,
  pirCopyText,
  ragChip,
  readPeriod,
  readTarget,
  valueKind,
} from "./quality-dashboard";

const t = createTranslator("en-GB");
const TODAY = "2026-10-31";

const form = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name] ?? null,
  getAll: (name: string) => (entries[name] === undefined ? [] : [entries[name] as string]),
});

const indicator = (over: Partial<QualityIndicatorOut>): QualityIndicatorOut => ({
  key: "falls",
  title: "Falls",
  unit: "per 1,000 occupied bed-days",
  direction: "lower_is_better",
  multiplier: 1000,
  method: "Falls: falls recorded ÷ occupied bed-days × 1,000.",
  source: "Incidents recorded as a fall",
  numerator: 6,
  denominator: 30,
  period: { from: "2026-09-01", to: "2026-09-30" },
  value: 200,
  display: 200,
  status: "amber",
  reasonCode: null,
  reason: null,
  target: null,
  ...over,
});

describe("the months a reader may choose (quality.md rule 42)", () => {
  it("offers whole months that have ended, newest first, across a year end", () => {
    const months = endedMonths(TODAY, 12);
    expect(months[0]).toEqual({ value: "2026-09", first: "2026-09-01", last: "2026-09-30" });
    expect(months.at(-1)?.value).toBe("2025-10");
    expect(endedMonths("2026-01-15", 2).map((m) => m.value)).toEqual(["2025-12", "2025-11"]);
    expect(endedMonths("2028-03-01", 1)[0]?.last).toBe("2028-02-29");
  });

  it.each<[string, Record<string, string>, string, string, string | null]>([
    ["nothing chosen: last month", {}, "2026-09", "2026-09", null],
    ["three whole months", { from: "2026-07", to: "2026-09" }, "2026-07", "2026-09", null],
    ["this month, not ended", { from: "2026-10", to: "2026-10" }, "2026-09", "2026-09", "unknown"],
    ["the wrong way round", { from: "2026-09", to: "2026-07" }, "2026-09", "2026-09", "order"],
    ["more than twelve", { from: "2025-09", to: "2026-09" }, "2026-09", "2026-09", "tooLong"],
    ["made-up text", { from: "soon", to: "2026-09" }, "2026-09", "2026-09", "unknown"],
  ])("reads %s", (_name, params, from, to, problem) => {
    const period = readPeriod(params, TODAY);
    expect([period.from.value, period.to.value, period.problem]).toEqual([from, to, problem]);
  });
});

describe("hazard HZ-129 figures and statuses in words", () => {
  it.each<[QualityIndicatorOut["status"], string, string]>([
    ["green", "circle-check", "Within target"],
    ["amber", "circle-alert", "Close to target"],
    ["red", "triangle-alert", "Outside target"],
    ["no_data", "circle-minus", "No rating"],
  ])("says %s with an icon and a word", (status, icon, label) => {
    expect(ragChip(status, t)).toMatchObject({ icon, label });
  });

  it("gives each figure its unit", () => {
    expect(figureWords(indicator({}), 5, t)).toBe("200 per 1,000 occupied bed-days");
    const reviews = indicator({ key: "overdue_reviews", unit: "percent", multiplier: 100 });
    expect(valueKind(reviews)).toBe("percent");
    expect(figureWords({ ...reviews, display: 25 }, 5, t)).toBe("25%");
  });

  it("never shows a withheld count as zero", () => {
    const withheld = indicator({
      numerator: null,
      value: null,
      display: null,
      reasonCode: "small_number",
    });
    expect(figureWords(withheld, 5, t)).toBe("Withheld: fewer than 5");
    expect(countWords(null, withheld, 5, t)).toBe("Withheld: fewer than 5");
    expect(countWords(0, withheld, 5, t)).toBe("0");
    const missing = indicator({ value: null, display: null, reasonCode: "source_not_built" });
    expect(figureWords(missing, 5, t)).toBe("No data");
    expect(countWords(null, missing, 5, t)).toBe("No data");
  });

  it("says why a figure has no rating", () => {
    expect(t("quality.dashboard.reason", { code: "source_not_built" })).toBe(
      "No data: Harbour does not record this yet.",
    );
  });
});

describe("the target form (quality.md rule 41)", () => {
  type Kind = {
    direction: "lower_is_better" | "higher_is_better";
    percent: boolean;
  };
  const lower: Kind = { direction: "lower_is_better", percent: false };
  const higherPercent: Kind = { direction: "higher_is_better", percent: true };

  it("reads a thousand written with a comma, and flags every percentage over 100", () => {
    expect(readTarget(form({ green: "1,000", amber: "2,500" }), lower, t)).toEqual({
      ok: true,
      green: 1000,
      amber: 2500,
    });
    expect(readTarget(form({ green: "120", amber: "110" }), higherPercent, t)).toEqual({
      ok: false,
      errors: {
        green: "Enter a percentage from 0 to 100",
        amber: "Enter a percentage from 0 to 100",
      },
    });
  });

  it("reads green and amber in the indicator's direction", () => {
    expect(readTarget(form({ green: "100", amber: "250" }), lower, t)).toEqual({
      ok: true,
      green: 100,
      amber: 250,
    });
    expect(readTarget(form({ green: "95", amber: "80.5" }), higherPercent, t)).toEqual({
      ok: true,
      green: 95,
      amber: 80.5,
    });
  });

  it.each<[string, Record<string, string>, Kind, Record<string, string>]>([
    [
      "missing numbers",
      { green: "", amber: "x" },
      lower,
      {
        green: "Enter a number for within target, for example 2.5",
        amber: "Enter a number for close to target, for example 5",
      },
    ],
    [
      "green looser than amber",
      { green: "300", amber: "100" },
      lower,
      { green: "Within target must be the same as close to target or lower" },
    ],
    [
      "a percentage over 100",
      { green: "120", amber: "80" },
      higherPercent,
      { green: "Enter a percentage from 0 to 100" },
    ],
    [
      "a negative number",
      { green: "-1", amber: "2" },
      lower,
      { green: "Enter a number for within target, for example 2.5" },
    ],
  ])("refuses %s", (_name, entries, kind, errors) => {
    expect(readTarget(form(entries), kind, t)).toEqual({ ok: false, errors });
  });
});

describe("the PIR prefill (quality.md rule 43)", () => {
  it("says answers in words", () => {
    expect(pirAnswer({ unit: "count", value: 8 }, t)).toBe("8");
    expect(pirAnswer({ unit: "yes_no", value: true }, t)).toBe("Yes");
    expect(pirAnswer({ unit: "percent", value: 92 }, t)).toBe("92%");
    expect(pirAnswer({ unit: "count", value: null }, t)).toBeNull();
    expect(pirChip("to_complete", t)).toMatchObject({ icon: "pen-line", label: "To complete" });
  });

  it("gives the text to copy its place, months and key questions, figures before what to complete", () => {
    const text = pirCopyText(
      [
        {
          key: "agency_hours",
          area: "safe",
          status: "to_complete",
          unit: "hours",
          value: null,
          reasonCode: "not_built",
        },
        {
          key: "incidents",
          area: "safe",
          status: "prefilled",
          unit: "count",
          value: 8,
          reasonCode: null,
        },
        {
          key: "digital_care_records",
          area: "well-led",
          status: "prefilled",
          unit: "yes_no",
          value: true,
          reasonCode: null,
        },
      ],
      { location: "Harbour House", from: "01/10/2025", to: "30/09/2026" },
      t,
    );
    expect(text.split("\n")).toEqual([
      "Harbour House, 01/10/2025 to 30/09/2026",
      "",
      "Safe:",
      "Incidents in the last 12 months: 8",
      "To complete: Agency hours in the last 4 weeks. Not recorded in Harbour yet: complete it from your own records.",
      "",
      "Well-led:",
      "Care records kept digitally: Yes",
    ]);
  });
});
