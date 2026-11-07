import { describe, expect, it } from "vitest";
import { cdPdfHref, marPrintHref, printableMonths } from "./medicines-print";

describe("hazard HZ-122 the months a MAR chart may be printed for", () => {
  it.each([
    ["mid-month", "2026-11-06T10:00:00Z", "2026-11", "November 2026", "2025-12"],
    [
      "the first hour of a month in UK summer time",
      "2026-08-31T23:30:00Z",
      "2026-09",
      "September 2026",
      "2025-10",
    ],
    [
      "January, reaching back into the year before",
      "2026-01-10T10:00:00Z",
      "2026-01",
      "January 2026",
      "2025-02",
    ],
  ])("%s", (_, now, first, label, last) => {
    const months = printableMonths(new Date(now));
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ value: first, label });
    expect(months[11]?.value).toBe(last);
  });

  it("links the downloads", () => {
    expect(marPrintHref("p1")).toBe("/people/p1/medicines/mar/print");
    expect(cdPdfHref("p1", "g1")).toBe("/people/p1/controlled-drugs/g1/pdf");
  });
});
