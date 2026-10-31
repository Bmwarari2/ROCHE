/**
 * An invented dm+d release for the reference data rules (ADR-0080): products that do not exist
 * ("Examplomycin", "Testoprofen"), identifiers in an invented range with valid check digits, and
 * GTINs in the GS1 restricted-circulation range 200. Never real dm+d data.
 */

import type {
  DmdAmp,
  DmdAmpp,
  DmdGtin,
  DmdLookupEntry,
  DmdReleaseContent,
  DmdVmp,
  DmdVmpp,
  DmdVtm,
} from "../src/medicines/dmd-release";

export const DMD = {
  vtm: "91000011000001107",
  vtm2: "91000021000001103",
  vmp: "91000051000001106",
  vmp2: "91000061000001109",
  vmpOld: "91000101000001106",
  vmpNew: "91000111000001108",
  amp: "91000131000001102",
  ampB: "91000141000001109",
  amp2: "91000151000001107",
  ampOld: "91000201000001104",
  vmpp: "91000221000001106",
  vmpp2: "91000231000001108",
  vmppOld: "91000271000001105",
  ampp: "91000291000001109",
  amppB: "91000301000001108",
  ampp2: "91000311000001105",
  amppOld: "91000361000001107",
  uomCapsule: "91000391000001103",
  uomMg: "91000401000001100",
  uomTablet: "91000381000001100",
  formCapsule: "91000441000001102",
  formTablet: "91000431000001109",
  routeOral: "91000461000001101",
  gtin: "02001234500012",
  gtinB: "02001234500029",
  gtin2: "02001234500043",
  gtinOld: "02001234500081",
} as const;

export const LOOKUPS: DmdLookupEntry[] = [
  { kind: "unit_of_measure", code: DMD.uomCapsule, description: "capsule", previousCode: null },
  { kind: "unit_of_measure", code: DMD.uomMg, description: "mg", previousCode: null },
  { kind: "unit_of_measure", code: DMD.uomTablet, description: "tablet", previousCode: null },
  { kind: "form", code: DMD.formCapsule, description: "Capsule", previousCode: null },
  { kind: "form", code: DMD.formTablet, description: "Tablet", previousCode: null },
  { kind: "route", code: DMD.routeOral, description: "Oral", previousCode: null },
  {
    kind: "control_drug_category",
    code: "9000",
    description: "No Controlled Drug Status",
    previousCode: null,
  },
  { kind: "legal_category", code: "9101", description: "POM", previousCode: null },
];

const vtm = (id: string, name: string): DmdVtm => ({
  id,
  name,
  abbreviatedName: null,
  invalid: false,
  previousId: null,
});

export const capsuleVmp = (over: Partial<DmdVmp> = {}): DmdVmp => ({
  id: DMD.vmp,
  vtmId: DMD.vtm,
  name: "Examplomycin 250mg capsules",
  abbreviatedName: null,
  invalid: false,
  previousId: null,
  unitDoseUomCode: DMD.uomCapsule,
  udfs: "1.000",
  udfsUomCode: DMD.uomCapsule,
  strengthUomCodes: [DMD.uomMg],
  formCode: DMD.formCapsule,
  routeCodes: [DMD.routeOral],
  controlDrugCategoryCode: "9000",
  ...over,
});

const amp = (id: string, vmpId: string, description: string, invalid = false): DmdAmp => ({
  id,
  vmpId,
  name: description.replace(/ \(.*\)$/, ""),
  abbreviatedName: null,
  description,
  invalid,
  licensedRouteCodes: [DMD.routeOral],
});

const vmpp = (id: string, vmpId: string, name: string): DmdVmpp => ({
  id,
  vmpId,
  name,
  quantity: "28.00",
  quantityUomCode: DMD.uomCapsule,
  invalid: false,
});

const ampp = (id: string, ampId: string, vmppId: string, invalid = false): DmdAmpp => ({
  id,
  vmppId,
  ampId,
  name: `Pack ${id}`,
  abbreviatedName: null,
  legalCategoryCode: "9101",
  discontinued: false,
  discontinuedOn: null,
  invalid,
});

export const gtin = (amppId: string, code: string, over: Partial<DmdGtin> = {}): DmdGtin => ({
  amppId,
  gtin: code,
  startDate: "2020-01-01",
  endDate: null,
  ...over,
});

/** A whole, valid release: two products, three brands, three packs and their barcodes. */
export function release(over: Partial<DmdReleaseContent> = {}): DmdReleaseContent {
  return {
    name: "fixture_dmd_1.0.0_20261026000001",
    releasedOn: "2026-10-26",
    lookups: LOOKUPS,
    vtms: [vtm(DMD.vtm, "Examplomycin"), vtm(DMD.vtm2, "Testoprofen")],
    vmps: [
      capsuleVmp(),
      capsuleVmp({
        id: DMD.vmp2,
        vtmId: DMD.vtm2,
        name: "Testoprofen 200mg tablets",
        unitDoseUomCode: DMD.uomTablet,
        udfsUomCode: DMD.uomTablet,
        formCode: DMD.formTablet,
      }),
    ],
    amps: [
      amp(DMD.amp, DMD.vmp, "Examplomycin 250mg capsules (Example Pharma Ltd)"),
      amp(DMD.ampB, DMD.vmp, "Examplomycin 250mg capsules (Sample Generics Ltd)"),
      amp(DMD.amp2, DMD.vmp2, "Testoprofen 200mg tablets (Example Pharma Ltd)"),
    ],
    vmpps: [
      vmpp(DMD.vmpp, DMD.vmp, "Examplomycin 250mg capsules 28 capsule"),
      vmpp(DMD.vmpp2, DMD.vmp2, "Testoprofen 200mg tablets 28 tablet"),
    ],
    ampps: [
      ampp(DMD.ampp, DMD.amp, DMD.vmpp),
      ampp(DMD.amppB, DMD.ampB, DMD.vmpp),
      ampp(DMD.ampp2, DMD.amp2, DMD.vmpp2),
    ],
    gtins: [gtin(DMD.ampp, DMD.gtin), gtin(DMD.amppB, DMD.gtinB), gtin(DMD.ampp2, DMD.gtin2)],
    ...over,
  };
}

export { amp as dmdAmp, ampp as dmdAmpp, vmpp as dmdVmpp, vtm as dmdVtm };
