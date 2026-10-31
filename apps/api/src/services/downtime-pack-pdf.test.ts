import { describe, expect, it } from "vitest";
import { pdfPages } from "../../test/support/pdf-text";
import { PLACES_NOT_CONFIRMED, renderDowntimePackPdf } from "./downtime-pack-pdf";

const content = (placesConfirmed?: boolean) => ({
  locationName: "Example House",
  pages: [],
  warnings: [],
  ...(placesConfirmed === undefined ? {} : { placesConfirmed }),
});

const frontSheet = (placesConfirmed?: boolean) =>
  (pdfPages(renderDowntimePackPdf(content(placesConfirmed), ["Downtime pack for test"]))[0] ?? [])
    .join(" ")
    .replace(/\s+/g, " ");

describe("hazard HZ-021 the front sheet says when the paper MAR and PEEP places are unconfirmed (H-213)", () => {
  it("hazard HZ-021 says it once, first among the warnings, while the places are unconfirmed", () => {
    const text = frontSheet(false);
    expect(text).toContain("Check these first (safety-critical first):");
    expect(text).not.toContain("No warnings.");
    const said = PLACES_NOT_CONFIRMED.replace(/\s+/g, " ");
    expect(text.split(said).length - 1).toBe(1);
  });

  it.each([
    ["confirmed", true],
    ["stored before the places were kept", undefined],
  ])("hazard HZ-021 says nothing about the places for a pack %s", (_label, confirmed) => {
    const text = frontSheet(confirmed);
    expect(text).toContain("No warnings.");
    expect(text).not.toContain("not confirmed in Harbour");
  });
});
