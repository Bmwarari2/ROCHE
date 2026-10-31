import { describe, expect, it } from "vitest";
import { assemblePirDraft, PIR_AREAS, PIR_DATA_POINTS } from "./quality-pir";

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
