import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { searchVector } from "./_columns";

/**
 * dm+d reference data (integrations.md section 11; INTG-006, MEDS-001; ADR-0080; HZ-113; migration
 * 0110). The NHS Dictionary of Medicines and Devices as the NHSBSA publishes it: global reference
 * tables with no `tenant_id`, like `bank_holiday`, read by every role and written only by the
 * release loader's functions (owned by the NOLOGIN `harbour_dmd_loader`), never by the application.
 * No personal data. Rows are never deleted (dm+d marks a concept invalid instead); each carries the
 * release that last added or changed it, so a release that changes nothing writes nothing.
 * Rules: packages/domain/src/medicines/dmd-release.ts; loader: packages/db/src/dmd.
 */

/** `DMD_LOOKUP_KINDS` in packages/domain. */
export const DMD_LOOKUP_KIND_CODES = [
  "unit_of_measure",
  "form",
  "route",
  "control_drug_category",
  "legal_category",
] as const;
/** `DMD_RELEASE_SOURCES` in packages/domain. */
export const DMD_RELEASE_SOURCE_CODES = ["nhsbsa_trud", "fixture", "manual"] as const;
/** `loading` exists only inside the loader's transaction; a committed release is finished. */
export const DMD_RELEASE_STATUS_CODES = ["loading", "loaded", "refused", "failed"] as const;

/** A dm+d (SNOMED CT concept) identifier's shape; the check digit is checked by the loader. */
const CONCEPT_ID = "'^[1-9][0-9]{5,17}$'";

/** The release history: every release loaded, refused or failed, never changed once finished. */
export const dmdRelease = pgTable(
  "dmd_release",
  {
    id: uuid("id").primaryKey().default(sql`app.uuid_v7()`),
    /** The release's own name, for example `nhsbsa_dmd_10.1.0_20261026000001`. */
    name: text("name").notNull(),
    releasedOn: date("released_on").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    /** SHA-256 of the release's files (names and contents), hex. */
    checksum: text("checksum"),
    /** Records read per file. */
    fileCounts: jsonb("file_counts").notNull().default(sql`'{}'::jsonb`),
    /** What a load added, changed, invalidated and withdrew. */
    changes: jsonb("changes").notNull().default(sql`'{}'::jsonb`),
    /** The first problems found (`DMD_PROBLEMS_KEPT`), for a refused or failed release. */
    problems: jsonb("problems").notNull().default(sql`'[]'::jsonb`),
    problemCount: integer("problem_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** The database role that ran the load (`harbour_worker`, `harbour_owner`): never a person. */
    loadedBy: text("loaded_by").notNull().default(sql`session_user`),
  },
  (t) => [
    uniqueIndex("dmd_release_loaded_name").on(t.name).where(sql`${t.status} = 'loaded'`),
    index("dmd_release_released_on").on(t.releasedOn),
    check("dmd_release_name", sql`length(${t.name}) BETWEEN 1 AND 200`),
    check("dmd_release_source", sql`${t.source} IN (${sqlList(DMD_RELEASE_SOURCE_CODES)})`),
    check("dmd_release_status", sql`${t.status} IN (${sqlList(DMD_RELEASE_STATUS_CODES)})`),
    check("dmd_release_checksum", sql`${t.checksum} IS NULL OR ${t.checksum} ~ '^[0-9a-f]{64}$'`),
    check(
      "dmd_release_finished",
      sql`(${t.status} = 'loading') = (${t.finishedAt} IS NULL)
        AND (${t.status} IN ('loading', 'loaded')) = (${t.problemCount} = 0)`,
    ),
  ],
);

const releaseRef = () => uuid("release_id").notNull();

/** `f_lookup2`: units of measure, forms, routes, controlled drug and legal categories. */
export const dmdLookup = pgTable(
  "dmd_lookup",
  {
    /** `kind:code`. */
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    code: text("code").notNull(),
    description: text("description").notNull(),
    previousCode: text("previous_code"),
    releaseId: releaseRef(),
  },
  (t) => [
    foreignKey({
      name: "dmd_lookup_release_fk",
      columns: [t.releaseId],
      foreignColumns: [dmdRelease.id],
    }),
    check("dmd_lookup_kind", sql`${t.kind} IN (${sqlList(DMD_LOOKUP_KIND_CODES)})`),
    check("dmd_lookup_id", sql`${t.id} = ${t.kind} || ':' || ${t.code}`),
    check("dmd_lookup_code", sql`${t.code} ~ '^[0-9A-Za-z]{1,20}$'`),
  ],
);

/** `f_vtm2`: virtual therapeutic moieties. */
export const dmdVtm = pgTable(
  "dmd_vtm",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    abbreviatedName: text("abbreviated_name"),
    invalid: boolean("invalid").notNull().default(false),
    previousId: text("previous_id"),
    /** The concept whose `previous_id` names this one: dm+d changed its identifier. */
    supersededBy: text("superseded_by"),
    releaseId: releaseRef(),
  },
  (t) => [
    foreignKey({
      name: "dmd_vtm_release_fk",
      columns: [t.releaseId],
      foreignColumns: [dmdRelease.id],
    }),
    check("dmd_vtm_id", sql.raw(`"id" ~ ${CONCEPT_ID}`)),
  ],
);

/** `f_vmp2`: virtual medicinal products, with their form, routes, units and controlled drug category. */
export const dmdVmp = pgTable(
  "dmd_vmp",
  {
    id: text("id").primaryKey(),
    vtmId: text("vtm_id"),
    name: text("name").notNull(),
    abbreviatedName: text("abbreviated_name"),
    invalid: boolean("invalid").notNull().default(false),
    previousId: text("previous_id"),
    supersededBy: text("superseded_by"),
    unitDoseUomCode: text("unit_dose_uom_code"),
    udfs: numeric("udfs"),
    udfsUomCode: text("udfs_uom_code"),
    strengthUomCodes: text("strength_uom_codes").array().notNull().default(sql`'{}'::text[]`),
    formCode: text("form_code"),
    routeCodes: text("route_codes").array().notNull().default(sql`'{}'::text[]`),
    controlDrugCategoryCode: text("control_drug_category_code"),
    releaseId: releaseRef(),
    searchName: searchVector("search_name", sql`app.search_vector(name)`),
  },
  (t) => [
    foreignKey({
      name: "dmd_vmp_release_fk",
      columns: [t.releaseId],
      foreignColumns: [dmdRelease.id],
    }),
    foreignKey({ name: "dmd_vmp_vtm_fk", columns: [t.vtmId], foreignColumns: [dmdVtm.id] }),
    index("dmd_vmp_vtm").on(t.vtmId),
    index("dmd_vmp_search_name").using("gin", t.searchName),
    check("dmd_vmp_id", sql.raw(`"id" ~ ${CONCEPT_ID}`)),
  ],
);

/** `f_amp2`: actual medicinal products (a supplier's or brand's product of a VMP). */
export const dmdAmp = pgTable(
  "dmd_amp",
  {
    id: text("id").primaryKey(),
    vmpId: text("vmp_id").notNull(),
    name: text("name").notNull(),
    abbreviatedName: text("abbreviated_name"),
    description: text("description").notNull(),
    invalid: boolean("invalid").notNull().default(false),
    licensedRouteCodes: text("licensed_route_codes").array().notNull().default(sql`'{}'::text[]`),
    releaseId: releaseRef(),
    searchName: searchVector("search_name", sql`app.search_vector(description)`),
  },
  (t) => [
    foreignKey({
      name: "dmd_amp_release_fk",
      columns: [t.releaseId],
      foreignColumns: [dmdRelease.id],
    }),
    foreignKey({ name: "dmd_amp_vmp_fk", columns: [t.vmpId], foreignColumns: [dmdVmp.id] }),
    index("dmd_amp_vmp").on(t.vmpId),
    index("dmd_amp_search_name").using("gin", t.searchName),
    check("dmd_amp_id", sql.raw(`"id" ~ ${CONCEPT_ID}`)),
  ],
);

/** `f_vmpp2`: virtual medicinal product packs. */
export const dmdVmpp = pgTable(
  "dmd_vmpp",
  {
    id: text("id").primaryKey(),
    vmpId: text("vmp_id").notNull(),
    name: text("name").notNull(),
    quantity: numeric("quantity"),
    quantityUomCode: text("quantity_uom_code"),
    invalid: boolean("invalid").notNull().default(false),
    releaseId: releaseRef(),
  },
  (t) => [
    foreignKey({
      name: "dmd_vmpp_release_fk",
      columns: [t.releaseId],
      foreignColumns: [dmdRelease.id],
    }),
    foreignKey({ name: "dmd_vmpp_vmp_fk", columns: [t.vmpId], foreignColumns: [dmdVmp.id] }),
    index("dmd_vmpp_vmp").on(t.vmpId),
    check("dmd_vmpp_id", sql.raw(`"id" ~ ${CONCEPT_ID}`)),
  ],
);

/** `f_ampp2`: actual medicinal product packs (the pack a barcode names). */
export const dmdAmpp = pgTable(
  "dmd_ampp",
  {
    id: text("id").primaryKey(),
    vmppId: text("vmpp_id").notNull(),
    ampId: text("amp_id").notNull(),
    name: text("name").notNull(),
    abbreviatedName: text("abbreviated_name"),
    legalCategoryCode: text("legal_category_code"),
    discontinued: boolean("discontinued").notNull().default(false),
    discontinuedOn: date("discontinued_on"),
    invalid: boolean("invalid").notNull().default(false),
    releaseId: releaseRef(),
  },
  (t) => [
    foreignKey({
      name: "dmd_ampp_release_fk",
      columns: [t.releaseId],
      foreignColumns: [dmdRelease.id],
    }),
    foreignKey({ name: "dmd_ampp_vmpp_fk", columns: [t.vmppId], foreignColumns: [dmdVmpp.id] }),
    foreignKey({ name: "dmd_ampp_amp_fk", columns: [t.ampId], foreignColumns: [dmdAmp.id] }),
    index("dmd_ampp_vmpp").on(t.vmppId),
    index("dmd_ampp_amp").on(t.ampId),
    check("dmd_ampp_id", sql.raw(`"id" ~ ${CONCEPT_ID}`)),
  ],
);

/**
 * `f_gtin2`: the GTINs on each pack, in force from `start_date` to `end_date`. A mapping absent from
 * a later release is kept, marked withdrawn by that release, and never matches a scan again unless
 * a release brings it back.
 */
export const dmdGtin = pgTable(
  "dmd_gtin",
  {
    /** `ampp:gtin:start`. */
    id: text("id").primaryKey(),
    amppId: text("ampp_id").notNull(),
    /** GTIN-14. */
    gtin: text("gtin").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    withdrawnReleaseId: uuid("withdrawn_release_id"),
    releaseId: releaseRef(),
  },
  (t) => [
    foreignKey({
      name: "dmd_gtin_release_fk",
      columns: [t.releaseId],
      foreignColumns: [dmdRelease.id],
    }),
    foreignKey({
      name: "dmd_gtin_withdrawn_release_fk",
      columns: [t.withdrawnReleaseId],
      foreignColumns: [dmdRelease.id],
    }),
    foreignKey({ name: "dmd_gtin_ampp_fk", columns: [t.amppId], foreignColumns: [dmdAmpp.id] }),
    index("dmd_gtin_gtin").on(t.gtin),
    index("dmd_gtin_ampp").on(t.amppId),
    check("dmd_gtin_gtin", sql`${t.gtin} ~ '^[0-9]{14}$'`),
    check(
      "dmd_gtin_key",
      sql`${t.id} = ${t.amppId} || ':' || ${t.gtin} || ':' || to_char(${t.startDate}, 'YYYY-MM-DD')`,
    ),
    check("dmd_gtin_dates", sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);
