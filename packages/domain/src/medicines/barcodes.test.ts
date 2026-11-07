import { describe, expect, it } from "vitest";
import { checkPack, type PackReference, parsePackBarcode, pointOfCareIssues } from "./barcodes";

// Invented dm+d ids and a GTIN with a valid check digit.
const GTIN = "05000000000012";
const reference: PackReference = {
  gtins: [{ gtin: GTIN, amppId: "1000003", startDate: "2020-01-01", endDate: null }],
  products: [
    { kind: "ampp", id: "1000003", vmpId: "1000001", ampId: "1000002" },
    { kind: "amp", id: "1000002", vmpId: "1000001", ampId: null },
  ],
};

describe("pack barcodes (ADR-0081)", () => {
  it.each([
    ["a linear EAN-13", "5000000000012", { gtin: GTIN, symbology: "linear" }],
    [
      "a GS1 DataMatrix with expiry, batch and serial",
      `]d201${GTIN}1728033110AB12\u001d21SER9`,
      { gtin: GTIN, expiry: "2028-03-31", batch: "AB12", serial: "SER9" },
    ],
    [
      "a GS1 DataMatrix in bracketed form with day 00",
      `(01)${GTIN}(17)280200(10)B1`,
      { gtin: GTIN, expiry: "2028-02-29", batch: "B1" },
    ],
  ] as const)("reads %s", (_case, raw, expected) => {
    expect(parsePackBarcode(raw)).toMatchObject(expected);
  });

  it.each([
    ["a bad check digit", "5000000000013"],
    ["text that is not a barcode", "hello"],
    ["an unknown application identifier", `]d299${GTIN}`],
    ["an impossible expiry", `]d201${GTIN}17281399`],
  ])("refuses %s", (_case, raw) => {
    expect(parsePackBarcode(raw)).toBeNull();
  });
});

describe("hazard HZ-113 a pack is matched to the MAR entry's product", () => {
  const scan = parsePackBarcode(`]d201${GTIN}17280331`);
  if (!scan) throw new Error("fixture");
  it.each([
    ["the entry's AMP", { vmpId: "1000001", ampId: "1000002" }, "2026-11-07", "matches"],
    [
      "the entry's VMP, prescribed generically",
      { vmpId: "1000001", ampId: null },
      "2026-11-07",
      "matches",
    ],
    ["another product", { vmpId: "9000001", ampId: null }, "2026-11-07", "different_product"],
    ["a pack past its expiry", { vmpId: "1000001", ampId: null }, "2028-04-01", "expired"],
  ] as const)("%s", (_case, product, today, result) => {
    expect(checkPack(scan, product, reference, today).result).toBe(result);
  });

  it("does not know a GTIN outside the reference data", () => {
    const other = parsePackBarcode("96385074");
    if (!other) throw new Error("fixture");
    expect(checkPack(other, { vmpId: "1000001", ampId: null }, reference, "2026-11-07")).toEqual({
      result: "unknown_pack",
    });
  });
});

describe("hazard HZ-001 refuses an administration without wristband scan or photo confirmation", () => {
  const none = { identity: null, pack: null, packOverride: null } as const;
  it.each([
    ["a dose with no checks", true, none, ["identity_not_confirmed", "pack_not_checked"]],
    [
      "a dose with photo confirmation and a scan",
      true,
      { ...none, identity: "photo", pack: "scanned" },
      [],
    ],
    [
      "a dose with a wristband and an override reason",
      true,
      {
        identity: "wristband",
        pack: "override",
        packOverride: { code: "no_barcode_on_pack", note: null },
      },
      [],
    ],
    [
      "an override of 'other' with no note",
      true,
      { identity: "photo", pack: "override", packOverride: { code: "other", note: " " } },
      ["override_note_missing"],
    ],
    ["a refusal, which gives nothing", false, none, []],
  ] as const)("%s", (_case, gives, checks, issues) => {
    expect(pointOfCareIssues(gives, checks)).toEqual(issues);
  });
});
