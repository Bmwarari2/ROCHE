import { z } from "zod";

/**
 * dm+d reference data (integrations.md section 11; INTG-006, MEDS-001; ADR-0080; HZ-113): search,
 * a product with its units and forms, the packs a barcode names, and the release history. National
 * reference data with no personal data. Every response carries the release in use and whether it
 * is out of date, so a screen can never show dm+d data without saying how old it is. Dates are
 * yyyy-mm-dd, times ISO 8601 with offset.
 */

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
/** A dm+d (SNOMED CT concept) identifier. */
const dmdId = z.string().regex(/^[1-9]\d{5,17}$/);

export const DmdReleaseStatus = z
  .object({
    /** The release in use; null when none is loaded. */
    name: z.string().nullable(),
    releasedOn: isoDate.nullable(),
    loadedAt: isoDateTime.nullable(),
    /** `out_of_date` when older than `medicines.dmd.stale_after_days` (rate table); `none` with no release. */
    status: z.enum(["current", "out_of_date", "none"]),
    ageDays: z.number().int().nullable(),
    staleAfterDays: z.number().int(),
    /** Plain English for the screen, shown with an icon and the word, never by colour alone. */
    message: z.string(),
  })
  .meta({ id: "DmdReleaseStatus" });
export type DmdReleaseStatus = z.infer<typeof DmdReleaseStatus>;

export const DmdCoded = z.object({ code: z.string(), name: z.string() }).meta({ id: "DmdCoded" });

export const DmdProductSummary = z
  .object({
    id: dmdId,
    kind: z.enum(["vmp", "amp"]),
    /** The dm+d name; an AMP's includes its supplier. */
    name: z.string(),
    vmpId: dmdId,
    vmpName: z.string(),
    form: DmdCoded.nullable(),
    routes: z.array(DmdCoded),
    controlledDrugCategory: DmdCoded.nullable(),
    /** dm+d marks a product invalid instead of deleting it: never to be chosen for a new entry. */
    invalid: z.boolean(),
    /** The product dm+d moved this one's identifier to, when it changed it. */
    supersededBy: dmdId.nullable(),
  })
  .meta({ id: "DmdProductSummary" });

export const DmdSearchResult = z
  .object({
    release: DmdReleaseStatus,
    query: z.object({ kind: z.enum(["text", "code"]), terms: z.array(z.string()) }),
    items: z.array(DmdProductSummary),
    /** More products matched than are listed: type more of the name. */
    truncated: z.boolean(),
  })
  .meta({ id: "DmdSearchResult" });

export const DmdPack = z
  .object({
    id: dmdId,
    kind: z.enum(["vmpp", "ampp"]),
    name: z.string(),
    /** For an AMPP, its VMPP. */
    vmppId: dmdId,
    ampId: dmdId.nullable(),
    quantity: z.string().nullable(),
    quantityUnit: DmdCoded.nullable(),
    legalCategory: DmdCoded.nullable(),
    discontinued: z.boolean(),
    discontinuedOn: isoDate.nullable(),
    invalid: z.boolean(),
    /** The GTINs on the pack in force today (AMPPs only). */
    gtins: z.array(z.string()),
  })
  .meta({ id: "DmdPack" });

export const DmdProductDetail = z
  .object({
    release: DmdReleaseStatus,
    product: DmdProductSummary.extend({
      abbreviatedName: z.string().nullable(),
      vtm: z.object({ id: dmdId, name: z.string(), invalid: z.boolean() }).nullable(),
      vmpInvalid: z.boolean(),
      /** The units a dose of this product may be written in (medicines.md rule 2). */
      doseUnits: z.array(DmdCoded),
      unitDoseForm: z.object({ size: z.string().nullable(), unit: DmdCoded.nullable() }).nullable(),
      /** An AMP's licensed routes (a VMP's routes are `routes`). */
      licensedRoutes: z.array(DmdCoded),
      /** The VMP's AMPs (for an AMP: none). */
      amps: z.array(z.object({ id: dmdId, name: z.string(), invalid: z.boolean() })),
      packs: z.array(DmdPack),
    }),
  })
  .meta({ id: "DmdProductDetail" });
export type DmdProductDetail = z.infer<typeof DmdProductDetail>;

export const DmdGtinMatch = z
  .object({
    release: DmdReleaseStatus,
    /** As GTIN-14. */
    gtin: z.string().regex(/^\d{14}$/),
    /**
     * Every pack the GTIN names today, from the release in use. More than one means the screen
     * asks the person to choose; slice 22 matches the scan to the MAR entry.
     */
    items: z
      .array(
        z.object({
          pack: DmdPack,
          amp: z.object({ id: dmdId, name: z.string(), invalid: z.boolean() }),
          vmp: z.object({ id: dmdId, name: z.string(), invalid: z.boolean() }),
          startDate: isoDate,
          endDate: isoDate.nullable(),
        }),
      )
      .min(1),
  })
  .meta({ id: "DmdGtinMatch" });

export const DmdReleaseHistory = z
  .object({
    release: DmdReleaseStatus,
    items: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        releasedOn: isoDate,
        source: z.enum(["nhsbsa_trud", "fixture", "manual"]),
        status: z.enum(["loaded", "refused", "failed"]),
        startedAt: isoDateTime,
        finishedAt: isoDateTime,
        fileCounts: z.record(z.string(), z.number().int()),
        changes: z.record(z.string(), z.number().int()),
        problems: z.array(
          z.object({
            code: z.string(),
            file: z.string().nullable(),
            id: z.string().nullable(),
            message: z.string(),
          }),
        ),
        problemCount: z.number().int(),
      }),
    ),
  })
  .meta({ id: "DmdReleaseHistory" });
