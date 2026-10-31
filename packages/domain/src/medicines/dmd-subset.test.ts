import { describe, expect, it } from "vitest";
import { capsuleVmp, DMD, dmdAmp, dmdAmpp, dmdVmpp, gtin, release } from "../../test/dmd-fixtures";
import { dmdGtinKey, dmdLookupKey } from "./dmd-release";
import { type DmdSubsetRows, selectDmdDeviceSubset } from "./dmd-subset";

/**
 * The dm+d subset a device holds (integrations.md section 11 rule 9; ADR-0080; HZ-113): only the
 * products on the location's MARs, their successors, the packs that could be in the person's hand
 * and the barcodes on them. Slice 68 sends it; these are the rules that choose it.
 */

const TODAY = "2026-10-31";

/** The fixture release as stored: a superseded product and its successor, and withdrawn GTINs. */
function rows(): DmdSubsetRows {
  const r = release();
  return {
    vmps: [
      ...r.vmps.map((v) => ({ ...v, supersededBy: null })),
      {
        ...capsuleVmp({ id: DMD.vmpOld, name: "Examplomycin 500mg capsules" }),
        supersededBy: DMD.vmpNew,
      },
      {
        ...capsuleVmp({
          id: DMD.vmpNew,
          name: "Examplomycin 500mg capsules",
          previousId: DMD.vmpOld,
        }),
        supersededBy: null,
      },
    ],
    amps: [
      ...r.amps,
      dmdAmp(DMD.ampOld, DMD.vmpNew, "Examplomycin 500mg capsules (Example Pharma Ltd)"),
      dmdAmp("91000211000001102", DMD.vmp, "Examplomycin 250mg capsules (Withdrawn Ltd)", true),
    ],
    vmpps: [...r.vmpps, dmdVmpp(DMD.vmppOld, DMD.vmpNew, "Examplomycin 500mg capsules 28 capsule")],
    ampps: [
      ...r.ampps,
      dmdAmpp(DMD.amppOld, DMD.ampOld, DMD.vmppOld),
      dmdAmpp("91000371000001102", DMD.amp, DMD.vmpp, true),
    ],
    gtins: [
      ...r.gtins.map((g) => ({ ...g, withdrawn: false })),
      { ...gtin(DMD.ampp, "02001234500036", { endDate: "2026-10-30" }), withdrawn: false },
      { ...gtin(DMD.ampp, "02001234500050", { startDate: "2026-12-01" }), withdrawn: false },
      { ...gtin(DMD.amppB, "02001234500067"), withdrawn: true },
      { ...gtin(DMD.amppOld, DMD.gtinOld), withdrawn: false },
      { ...gtin("91000371000001102", "02001234500074"), withdrawn: false },
    ],
  };
}

describe("hazard HZ-113 the device subset (rule 9)", () => {
  it("holds nothing for a location with no medicines", () => {
    expect(selectDmdDeviceSubset([], rows(), TODAY)).toEqual({
      vtmIds: [],
      vmpIds: [],
      ampIds: [],
      vmppIds: [],
      amppIds: [],
      gtinKeys: [],
      lookupKeys: [],
      unresolved: [],
    });
  });

  it("brings every valid brand and pack of a VMP, with the barcodes in force", () => {
    const subset = selectDmdDeviceSubset([{ vmpId: DMD.vmp, ampId: null }], rows(), TODAY);
    expect(subset.vtmIds).toEqual([DMD.vtm]);
    expect(subset.vmpIds).toEqual([DMD.vmp]);
    expect(subset.ampIds).toEqual([DMD.amp, DMD.ampB].sort());
    expect(subset.amppIds).toEqual([DMD.ampp, DMD.amppB].sort());
    expect(subset.vmppIds).toEqual([DMD.vmpp]);
    expect(subset.gtinKeys).toEqual(
      [
        dmdGtinKey(gtin(DMD.ampp, DMD.gtin)),
        dmdGtinKey(gtin(DMD.amppB, DMD.gtinB)),
        dmdGtinKey(gtin(DMD.ampp, "02001234500050", { startDate: "2026-12-01" })),
      ].sort(),
    );
    expect(subset.lookupKeys).toEqual(
      [
        dmdLookupKey({ kind: "unit_of_measure", code: DMD.uomCapsule }),
        dmdLookupKey({ kind: "unit_of_measure", code: DMD.uomMg }),
        dmdLookupKey({ kind: "form", code: DMD.formCapsule }),
        dmdLookupKey({ kind: "route", code: DMD.routeOral }),
        dmdLookupKey({ kind: "control_drug_category", code: "9000" }),
        dmdLookupKey({ kind: "legal_category", code: "9101" }),
      ].sort(),
    );
    expect(subset.unresolved).toEqual([]);
  });

  it("leaves out invalid brands and packs, withdrawn barcodes and ones that have ended", () => {
    const subset = selectDmdDeviceSubset([{ vmpId: DMD.vmp, ampId: null }], rows(), TODAY);
    expect(subset.ampIds).not.toContain("91000211000001102");
    expect(subset.amppIds).not.toContain("91000371000001102");
    expect(subset.gtinKeys.join()).not.toContain("02001234500036");
    expect(subset.gtinKeys.join()).not.toContain("02001234500067");
    expect(subset.gtinKeys.join()).not.toContain("02001234500074");
  });

  it("brings only the named brand's packs for an entry naming an AMP", () => {
    const subset = selectDmdDeviceSubset([{ vmpId: DMD.vmp, ampId: DMD.ampB }], rows(), TODAY);
    expect(subset.ampIds).toEqual([DMD.ampB]);
    expect(subset.amppIds).toEqual([DMD.amppB]);
    expect(subset.gtinKeys).toEqual([dmdGtinKey(gtin(DMD.amppB, DMD.gtinB))]);
  });

  it("brings an invalid AMP the MAR names, so the device shows what was prescribed, but not its invalid packs", () => {
    const subset = selectDmdDeviceSubset(
      [{ vmpId: DMD.vmp, ampId: "91000211000001102" }],
      rows(),
      TODAY,
    );
    expect(subset.ampIds).toEqual(["91000211000001102"]);
    expect(subset.amppIds).toEqual([]);
  });

  it("follows a product whose identifier dm+d changed to its successor and its packs", () => {
    const subset = selectDmdDeviceSubset([{ vmpId: DMD.vmpOld, ampId: null }], rows(), TODAY);
    expect(subset.vmpIds).toEqual([DMD.vmpOld, DMD.vmpNew].sort());
    expect(subset.ampIds).toEqual([DMD.ampOld]);
    expect(subset.amppIds).toEqual([DMD.amppOld]);
    expect(subset.vmppIds).toEqual([DMD.vmppOld]);
    expect(subset.gtinKeys).toEqual([dmdGtinKey(gtin(DMD.amppOld, DMD.gtinOld))]);
  });

  it("says which products the MAR names that the reference data does not hold", () => {
    const subset = selectDmdDeviceSubset(
      [
        { vmpId: "91000981000001102", ampId: "91000991000001106" },
        { vmpId: DMD.vmp2, ampId: DMD.amp },
        { vmpId: DMD.vmp2, ampId: "91000171000001100" },
      ],
      rows(),
      TODAY,
    );
    expect(subset.unresolved).toEqual(
      ["91000981000001102", "91000991000001106", DMD.amp, "91000171000001100"].sort(),
    );
    expect(subset.vmpIds).toEqual([DMD.vmp2]);
    expect(subset.ampIds).toEqual([]);
  });

  it("names each row once however many entries need it, and stops on a loop of successors", () => {
    const looped = rows();
    const vmps = looped.vmps.map((v) =>
      v.id === DMD.vmpNew ? { ...v, supersededBy: DMD.vmpOld } : v,
    );
    const subset = selectDmdDeviceSubset(
      [
        { vmpId: DMD.vmpOld, ampId: null },
        { vmpId: DMD.vmpOld, ampId: null },
        { vmpId: DMD.vmpNew, ampId: DMD.ampOld },
      ],
      { ...looped, vmps },
      TODAY,
    );
    expect(subset.vmpIds).toEqual([DMD.vmpOld, DMD.vmpNew].sort());
    expect(subset.amppIds).toEqual([DMD.amppOld]);
  });

  it("says a pack whose VMPP the rows lack is unresolved", () => {
    const r = rows();
    const subset = selectDmdDeviceSubset(
      [{ vmpId: DMD.vmp2, ampId: null }],
      { ...r, vmpps: r.vmpps.filter((v) => v.id !== DMD.vmpp2) },
      TODAY,
    );
    expect(subset.amppIds).toEqual([DMD.ampp2]);
    expect(subset.unresolved).toEqual([DMD.vmpp2]);
  });
});
