import { describe, expect, it } from "vitest";
import {
  assemblePirDraft,
  PIR_AREAS,
  PIR_BUILT,
  PIR_DATA_POINTS,
  PIR_QUESTION_SET,
  PIR_REASONS,
  pirPrefill,
} from "./quality-pir";

describe("PIR prefill (quality.md 17.3 rules 23 and 24; QUAL-006)", () => {
  it("rule 23 lists each data point once, in a CQC key question, with its source", () => {
    expect(new Set(PIR_DATA_POINTS.map((p) => p.key)).size).toBe(PIR_DATA_POINTS.length);
    for (const point of PIR_DATA_POINTS) {
      expect(PIR_AREAS).toContain(point.area);
      expect(point.source.length).toBeGreaterThan(0);
    }
  });

  it("rule 24 shows each value with its date and records, in key question order", () => {
    const draft = assemblePirDraft({
      incidents: { value: 12, asOf: "2026-10-31", records: 12 },
      digital_care_records: { value: true, asOf: "2026-10-31", records: 1 },
    });
    expect(draft).toHaveLength(PIR_DATA_POINTS.length);
    const areas = draft.map((d) => PIR_AREAS.indexOf(d.dataPoint.area));
    expect(areas).toEqual([...areas].sort((a, b) => a - b));
    expect(draft.find((d) => d.dataPoint.key === "incidents")).toMatchObject({
      value: { value: 12, records: 12 },
      notAvailable: null,
    });
    expect(draft.find((d) => d.dataPoint.key === "digital_care_records")?.value?.value).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no value at all", {}],
    ["a null value", { complaints: null }],
    [
      "a value that is not a number",
      { complaints: { value: Number.NaN, asOf: "2026-10-31", records: 0 } },
    ],
    ["yes or no for a count", { complaints: { value: true, asOf: "2026-10-31", records: 1 } }],
  ])("rule 24 says not available, never 0, for %s", (_, values) => {
    const item = assemblePirDraft(values as never).find((d) => d.dataPoint.key === "complaints");
    expect(item?.value).toBeNull();
    expect(item?.notAvailable).toBe("Not available in Harbour: check your own records.");
  });
});

describe("PIR prefill marks each data point (quality.md 22.2 rule 43; slice 47)", () => {
  const asOf = "2026-10-30";
  const minGroupSize = 5;

  it("names the question set it maps to, unconfirmed until H-602", () => {
    expect(PIR_QUESTION_SET).toMatchObject({ regulator: "cqc", confirmed: false });
    expect(PIR_QUESTION_SET.version.length).toBeGreaterThan(0);
  });

  it("knows which data points Harbour records today", () => {
    expect([...PIR_BUILT].sort()).toEqual([
      "digital_care_records",
      "incidents",
      "medication_errors",
    ]);
  });

  it.each<[string, string, unknown, string, string | null]>([
    ["a count Harbour has", "incidents", { value: 12, asOf, records: 12 }, "prefilled", null],
    ["zero, shown", "medication_errors", { value: 0, asOf, records: 0 }, "prefilled", null],
    [
      "a small number",
      "medication_errors",
      { value: 2, asOf, records: 2 },
      "to_complete",
      "small_number",
    ],
    [
      "a source not built",
      "complaints",
      { value: 3, asOf, records: 3 },
      "to_complete",
      "not_built",
    ],
    ["a source not built and no value", "vacancies", undefined, "to_complete", "not_built"],
    ["no value for a built source", "incidents", null, "to_complete", "no_value"],
    [
      "yes for digital records",
      "digital_care_records",
      { value: true, asOf, records: 40 },
      "prefilled",
      null,
    ],
  ])("hazard HZ-129 rule 43 %s", (_name, key, value, status, reasonCode) => {
    const item = pirPrefill({ [key]: value as never }, { minGroupSize }).find(
      (i) => i.dataPoint.key === key,
    );
    expect(item?.status).toBe(status);
    expect(item?.reasonCode).toBe(reasonCode);
    if (status === "prefilled") {
      expect(item?.value).toEqual(value);
      expect(item?.reason).toBeNull();
    } else {
      expect(item?.value).toBeNull();
      expect(item?.reason).toBe(PIR_REASONS[reasonCode as keyof typeof PIR_REASONS]);
    }
  });

  it("lists every data point, in key question order", () => {
    const items = pirPrefill({}, { minGroupSize });
    expect(items.map((i) => i.dataPoint.key)).toEqual(
      assemblePirDraft({}).map((d) => d.dataPoint.key),
    );
    expect(items.every((i) => i.status === "to_complete")).toBe(true);
  });
});
