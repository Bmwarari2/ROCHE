/**
 * Test support for the medicines rules. The dm+d identifiers are invented (the "9000..." range in
 * dm+d's namespace, with valid check digits) so no fixture can be mistaken for a real product's
 * reference data; the person is invented ("Ada Example") and staff are opaque ids.
 */

import type { DmdProductRef, DmdRoute } from "../src/medicines/dmd";
import type { DoseUnit } from "../src/medicines/dose";
import type { DmdProductFacts, MarEntry, MarEntryDraft } from "../src/medicines/mar-entry";
import { transcribeMarEntry } from "../src/medicines/mar-entry";

export const PERSON = "person-ada-example";
export const TRANSCRIBER = "member-transcriber";
export const CHECKER = "member-checker";

export const UNIT = {
  tablet: { code: "uom-tablet", name: "tablet" },
  mg: { code: "uom-mg", name: "mg" },
  ml: { code: "uom-ml", name: "ml" },
  microgram: { code: "uom-microgram", name: "microgram" },
  unit: { code: "uom-unit", name: "unit" },
} as const satisfies Record<string, DoseUnit>;

export const ORAL: DmdRoute = { code: "route-oral", name: "Oral" };
export const SUBCUTANEOUS: DmdRoute = { code: "route-subcutaneous", name: "Subcutaneous" };

export const PRODUCT = {
  paracetamolTablets: {
    vmpId: "90000011000001104",
    ampId: null,
    name: "Paracetamol 500mg tablets",
  },
  paracetamolBrandA: {
    vmpId: "90000011000001104",
    ampId: "90000021000001108",
    name: "Paracetamol 500mg tablets (brand A)",
  },
  paracetamolBrandB: {
    vmpId: "90000011000001104",
    ampId: "90000031000001105",
    name: "Paracetamol 500mg tablets (brand B)",
  },
  paracetamolCapsules: {
    vmpId: "90000041000001103",
    ampId: null,
    name: "Paracetamol 500mg capsules",
  },
  alendronicAcid: { vmpId: "90000051000001100", ampId: null, name: "Alendronic acid 70mg tablets" },
  levothyroxine: {
    vmpId: "90000061000001102",
    ampId: null,
    name: "Levothyroxine sodium 25microgram tablets",
  },
  warfarin: { vmpId: "90000071000001107", ampId: null, name: "Warfarin 1mg tablets" },
  apixaban: { vmpId: "90000081000001109", ampId: null, name: "Apixaban 5mg tablets" },
} as const satisfies Record<string, DmdProductRef>;

export const TABLET_FACTS: DmdProductFacts = {
  permittedDoseUnits: [UNIT.tablet, UNIT.mg],
  permittedRoutes: [ORAL],
};

export const SOURCE = {
  kind: "prescription",
  reference: "Repeat prescription from the GP practice, 30/10/2026",
  documentId: "document-1",
} as const;

export function draft(overrides: Partial<MarEntryDraft> = {}): MarEntryDraft {
  return {
    personId: PERSON,
    product: PRODUCT.paracetamolTablets,
    route: ORAL,
    directions: {
      kind: "regular",
      schedule: {
        pattern: { kind: "every_day" },
        times: [
          { time: "08:00", dose: { kind: "amount", quantity: 2, unit: UNIT.tablet } },
          { time: "18:00", dose: { kind: "amount", quantity: 2, unit: UNIT.tablet } },
        ],
      },
    },
    indication: "Pain",
    specialInstructions: null,
    prescriber: "Dr Example, GP",
    startsAt: new Date("2026-11-02T00:00:00Z"),
    stopsAt: null,
    reviewOn: "2027-05-01",
    source: SOURCE,
    ...overrides,
  };
}

/** A new entry from `draft`, transcribed by TRANSCRIBER; throws if the draft is refused. */
export function entry(overrides: Partial<MarEntryDraft> = {}, id = "entry-1"): MarEntry {
  const result = transcribeMarEntry(draft(overrides), TABLET_FACTS, {
    id,
    by: TRANSCRIBER,
    at: new Date("2026-11-01T10:00:00Z"),
    origin: "transcribed",
    earlierEntries: [],
  });
  if (!result.ok) throw new Error(result.issues.map((i) => i.message).join(" "));
  return result.entry;
}
