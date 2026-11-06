import { describe, expect, it } from "vitest";
import { pdfPages } from "../../test/support/pdf-text";
import { PLACES_NOT_CONFIRMED, renderDowntimePackPdf } from "./downtime-pack-pdf";

const content = { locationName: "Example House", pages: [], warnings: [] };

const frontSheet = (placesConfirmed?: boolean) =>
  (
    pdfPages(
      renderDowntimePackPdf(
        content,
        ["Downtime pack for test"],
        ...(placesConfirmed === undefined ? [] : [{ placesConfirmed }]),
      ),
    )[0] ?? []
  )
    .join(" ")
    .replace(/\s+/g, " ");

describe("hazard HZ-021 the front sheet says when the paper MAR and PEEP places are unconfirmed (H-213)", () => {
  it.each([
    ["unconfirmed", false],
    ["not given (unconfirmed)", undefined],
  ])(
    "hazard HZ-021 says it once, first among the warnings, while the places are %s",
    (_label, confirmed) => {
      const text = frontSheet(confirmed);
      expect(text).toContain("Check these first (safety-critical first):");
      expect(text).not.toContain("No warnings.");
      const said = PLACES_NOT_CONFIRMED.replace(/\s+/g, " ");
      expect(text.split(said).length - 1).toBe(1);
    },
  );

  it("hazard HZ-021 says nothing about the places once they are confirmed", () => {
    const text = frontSheet(true);
    expect(text).toContain("No warnings.");
    expect(text).not.toContain("not confirmed in Harbour");
  });
});
