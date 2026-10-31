import type { DmdReleaseStatus } from "@harbour/contracts";
import type { Transaction } from "@harbour/db";
import {
  DMD_SEARCH_LIMITS,
  type DmdSearchQuery,
  dmdDoseUnitCodes,
  dmdReleaseFreshness,
  resolveRate,
  ukDateOf,
} from "@harbour/domain";
import { sql } from "drizzle-orm";
import { rateRows } from "./rates";

/**
 * Reads of the dm+d reference tables (integrations.md section 11 rules 5 to 7; ADR-0080; HZ-113).
 * Global data with no personal data, read under the request's own context (forced row-level
 * security with a read policy for every role). Only the release in use is ever shown, with its
 * date and whether it is out of date.
 */

/** Out of date after this many days (rate table; a national figure, never a tenant's). */
export const DMD_STALE_AFTER_KEY = "medicines.dmd.stale_after_days";

type Row = Record<string, unknown>;
const rows = async <T extends Row>(tx: Transaction, q: ReturnType<typeof sql>) =>
  (await tx.execute<T>(q)).rows;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export interface DmdReleaseInUse {
  readonly id: string;
  readonly name: string;
  readonly releasedOn: string;
  readonly loadedAt: string;
}

/** The release in use: the latest loaded, by release date. */
export async function dmdReleaseInUse(tx: Transaction): Promise<DmdReleaseInUse | null> {
  const [row] = await rows<{ id: string; name: string; released_on: string; finished_at: Date }>(
    tx,
    sql`SELECT id, name, to_char(released_on, 'YYYY-MM-DD') AS released_on, finished_at
          FROM dmd_release WHERE status = 'loaded'
         ORDER BY released_on DESC, finished_at DESC LIMIT 1`,
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    releasedOn: row.released_on,
    loadedAt: new Date(row.finished_at).toISOString(),
  };
}

/** The release in use and whether it is out of date (rule 5), for every response. */
export async function dmdReleaseStatus(
  tx: Transaction,
  now: Date = new Date(),
): Promise<DmdReleaseStatus> {
  const today = ukDateOf(now);
  const staleAfterDays = resolveRate(
    await rateRows(tx, [DMD_STALE_AFTER_KEY]),
    DMD_STALE_AFTER_KEY,
    "england",
    today,
    null,
  ).value;
  const release = await dmdReleaseInUse(tx);
  const freshness = dmdReleaseFreshness(release, today, staleAfterDays);
  return {
    name: release?.name ?? null,
    releasedOn: release?.releasedOn ?? null,
    loadedAt: release?.loadedAt ?? null,
    status: freshness.status,
    ageDays: freshness.ageDays,
    staleAfterDays,
    message: freshness.message,
  };
}

/** Names for lookup codes (`kind:code` keys). */
async function lookupNames(tx: Transaction, keys: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return new Map();
  const found = await rows<{ id: string; description: string }>(
    tx,
    sql`SELECT id, description FROM dmd_lookup WHERE id = ANY(${sql.param(unique)}::text[])`,
  );
  return new Map(found.map((r) => [r.id, r.description]));
}

const coded = (names: Map<string, string>, kind: string, code: string | null) => {
  if (code === null) return null;
  const name = names.get(`${kind}:${code}`);
  return name === undefined ? null : { code, name };
};
const codedAll = (names: Map<string, string>, kind: string, codes: readonly string[]) =>
  codes.flatMap((c) => {
    const found = coded(names, kind, c);
    return found ? [found] : [];
  });

interface ProductRow extends Row {
  id: string;
  kind: "vmp" | "amp";
  name: string;
  vmp_id: string;
  vmp_name: string;
  form_code: string | null;
  route_codes: string[];
  control_drug_category_code: string | null;
  invalid: boolean;
  superseded_by: string | null;
}

const VMP_COLUMNS = sql`v.form_code, v.route_codes, v.control_drug_category_code`;

async function summaries(tx: Transaction, found: ProductRow[]) {
  const names = await lookupNames(
    tx,
    found.flatMap((r) => [
      `form:${r.form_code}`,
      ...strs(r.route_codes).map((c) => `route:${c}`),
      `control_drug_category:${r.control_drug_category_code}`,
    ]),
  );
  return found.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    vmpId: r.vmp_id,
    vmpName: r.vmp_name,
    form: coded(names, "form", str(r.form_code)),
    routes: codedAll(names, "route", strs(r.route_codes)),
    controlledDrugCategory: coded(
      names,
      "control_drug_category",
      str(r.control_drug_category_code),
    ),
    invalid: r.invalid,
    supersededBy: str(r.superseded_by),
  }));
}

/**
 * Search (rule 6): VMPs and AMPs whose names start with each word typed, or the product with the
 * code typed; invalid and superseded products only when asked for, or when their code is typed (and
 * then marked); shortest names first; at most `DMD_SEARCH_LIMITS.maxResults`.
 */
export async function searchDmdProducts(
  tx: Transaction,
  query: DmdSearchQuery,
  includeInvalid: boolean,
) {
  const limit = DMD_SEARCH_LIMITS.maxResults;
  const vmpWhere =
    query.kind === "code"
      ? sql`v.id = ${query.id}`
      : sql`v.search_name @@ to_tsquery('app.harbour_search', ${query.tsQuery})`;
  const ampWhere =
    query.kind === "code"
      ? sql`a.id = ${query.id}`
      : sql`a.search_name @@ to_tsquery('app.harbour_search', ${query.tsQuery})`;
  // A technical bound, so a broad prefix over a whole release cannot hold a connection.
  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
  // A name search leaves out invalid products and those dm+d has given a new identifier, unless
  // asked; a typed code is exact, so it shows the product whatever its state, marked.
  const everything = includeInvalid || query.kind === "code";
  const valid = everything ? sql`true` : sql`NOT v.invalid AND v.superseded_by IS NULL`;
  const validAmp = everything
    ? sql`true`
    : sql`NOT a.invalid AND NOT v.invalid AND v.superseded_by IS NULL`;
  const found = await rows<ProductRow>(
    tx,
    sql`SELECT * FROM (
          SELECT v.id, 'vmp' AS kind, v.name, v.id AS vmp_id, v.name AS vmp_name, ${VMP_COLUMNS},
                 v.invalid, v.superseded_by
            FROM dmd_vmp v WHERE ${vmpWhere} AND ${valid}
          UNION ALL
          SELECT a.id, 'amp' AS kind, a.description AS name, v.id AS vmp_id, v.name AS vmp_name,
                 ${VMP_COLUMNS}, a.invalid OR v.invalid AS invalid, v.superseded_by
            FROM dmd_amp a JOIN dmd_vmp v ON v.id = a.vmp_id WHERE ${ampWhere} AND ${validAmp}
        ) found
        ORDER BY length(name), name, kind DESC
        LIMIT ${limit + 1}`,
  );
  return {
    items: await summaries(tx, found.slice(0, limit)),
    truncated: found.length > limit,
  };
}

interface PackRow extends Row {
  id: string;
  kind: "vmpp" | "ampp";
  name: string;
  vmpp_id: string;
  amp_id: string | null;
  quantity: string | null;
  quantity_uom_code: string | null;
  legal_category_code: string | null;
  discontinued: boolean;
  discontinued_on: string | null;
  invalid: boolean;
  gtins: string[] | null;
}

/** GTIN mappings in force on a UK date and present in the release in use (rule 7). */
const IN_FORCE = (today: string) =>
  sql`g.withdrawn_release_id IS NULL AND g.start_date <= ${today}::date
      AND (g.end_date IS NULL OR g.end_date >= ${today}::date)`;

function packOf(r: PackRow, names: Map<string, string>) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    vmppId: r.vmpp_id,
    ampId: str(r.amp_id),
    quantity: str(r.quantity),
    quantityUnit: coded(names, "unit_of_measure", str(r.quantity_uom_code)),
    legalCategory: coded(names, "legal_category", str(r.legal_category_code)),
    discontinued: r.discontinued,
    discontinuedOn: str(r.discontinued_on),
    invalid: r.invalid,
    gtins: strs(r.gtins),
  };
}

const packLookups = (packs: readonly PackRow[]) =>
  packs.flatMap((p) => [
    `unit_of_measure:${p.quantity_uom_code}`,
    `legal_category:${p.legal_category_code}`,
  ]);

/** A VMP with its AMPs and packs, or an AMP with its VMP and packs; null when dm+d has no such product. */
export async function dmdProductDetail(tx: Transaction, id: string, today: string) {
  const [amp] = await rows<Row>(
    tx,
    sql`SELECT id AS amp_id, vmp_id, description AS amp_name, abbreviated_name AS amp_abbreviated,
               invalid AS amp_invalid, licensed_route_codes
          FROM dmd_amp WHERE id = ${id}`,
  );
  const [found] = await rows<Row>(
    tx,
    sql`SELECT v.*, t.name AS vtm_name, t.invalid AS vtm_invalid
          FROM dmd_vmp v LEFT JOIN dmd_vtm t ON t.id = v.vtm_id
         WHERE v.id = ${amp ? String(amp.vmp_id) : id}`,
  );
  if (!found) return null;
  const vmp: Row = { ...found, ...(amp ?? {}) };
  const isAmp = amp !== undefined;
  const vmpId = String(found.id);
  const amps = isAmp
    ? []
    : await rows<{ id: string; name: string; invalid: boolean }>(
        tx,
        sql`SELECT id, description AS name, invalid FROM dmd_amp WHERE vmp_id = ${vmpId}
             ORDER BY invalid, description`,
      );
  const gtins = sql`(SELECT array_agg(g.gtin ORDER BY g.gtin) FROM dmd_gtin g
                      WHERE g.ampp_id = p.id AND ${IN_FORCE(today)})`;
  const packs = await rows<PackRow>(
    tx,
    isAmp
      ? sql`SELECT p.id, 'ampp' AS kind, p.name, p.vmpp_id, p.amp_id, vp.quantity::text AS quantity,
                   vp.quantity_uom_code, p.legal_category_code, p.discontinued,
                   to_char(p.discontinued_on, 'YYYY-MM-DD') AS discontinued_on, p.invalid,
                   ${gtins} AS gtins
              FROM dmd_ampp p JOIN dmd_vmpp vp ON vp.id = p.vmpp_id
             WHERE p.amp_id = ${String(vmp.amp_id)}
             ORDER BY p.invalid, p.name`
      : sql`SELECT p.id, 'vmpp' AS kind, p.name, p.id AS vmpp_id, NULL AS amp_id,
                   p.quantity::text AS quantity, p.quantity_uom_code, NULL AS legal_category_code,
                   false AS discontinued, NULL AS discontinued_on, p.invalid, NULL AS gtins
              FROM dmd_vmpp p WHERE p.vmp_id = ${vmpId}
             ORDER BY p.invalid, p.name`,
  );
  const routeCodes = strs(vmp.route_codes);
  const licensed = isAmp ? strs(vmp.licensed_route_codes) : [];
  const doseUnits = dmdDoseUnitCodes({
    unitDoseUomCode: str(vmp.unit_dose_uom_code),
    udfsUomCode: str(vmp.udfs_uom_code),
    strengthUomCodes: strs(vmp.strength_uom_codes),
  });
  const names = await lookupNames(tx, [
    `form:${vmp.form_code}`,
    `control_drug_category:${vmp.control_drug_category_code}`,
    `unit_of_measure:${vmp.udfs_uom_code}`,
    ...[...routeCodes, ...licensed].map((c) => `route:${c}`),
    ...doseUnits.map((c) => `unit_of_measure:${c}`),
    ...packLookups(packs),
  ]);
  const vmpInvalid = Boolean(vmp.invalid);
  return {
    id: isAmp ? String(vmp.amp_id) : vmpId,
    kind: isAmp ? ("amp" as const) : ("vmp" as const),
    name: isAmp ? String(vmp.amp_name) : String(vmp.name),
    abbreviatedName: str(isAmp ? vmp.amp_abbreviated : vmp.abbreviated_name),
    vmpId,
    vmpName: String(vmp.name),
    vtm:
      vmp.vtm_id === null
        ? null
        : { id: String(vmp.vtm_id), name: String(vmp.vtm_name), invalid: Boolean(vmp.vtm_invalid) },
    form: coded(names, "form", str(vmp.form_code)),
    routes: codedAll(names, "route", routeCodes),
    licensedRoutes: codedAll(names, "route", licensed),
    controlledDrugCategory: coded(
      names,
      "control_drug_category",
      str(vmp.control_drug_category_code),
    ),
    invalid: isAmp ? Boolean(vmp.amp_invalid) || vmpInvalid : vmpInvalid,
    vmpInvalid,
    supersededBy: str(vmp.superseded_by),
    doseUnits: codedAll(names, "unit_of_measure", doseUnits),
    unitDoseForm:
      vmp.udfs === null && vmp.udfs_uom_code === null
        ? null
        : {
            size: str(vmp.udfs),
            unit: coded(names, "unit_of_measure", str(vmp.udfs_uom_code)),
          },
    amps: amps.map((a) => ({ id: a.id, name: a.name, invalid: a.invalid })),
    packs: packs.map((p) => packOf(p, names)),
  };
}

/** Every pack a GTIN-14 names on a UK date, with its AMP and VMP (rule 7). */
export async function dmdGtinMatches(tx: Transaction, gtin14: string, today: string) {
  const found = await rows<
    PackRow & {
      amp_name: string;
      amp_invalid: boolean;
      vmp_id: string;
      vmp_name: string;
      vmp_invalid: boolean;
      start_date: string;
      end_date: string | null;
    }
  >(
    tx,
    sql`SELECT p.id, 'ampp' AS kind, p.name, p.vmpp_id, p.amp_id, vp.quantity::text AS quantity,
               vp.quantity_uom_code, p.legal_category_code, p.discontinued,
               to_char(p.discontinued_on, 'YYYY-MM-DD') AS discontinued_on, p.invalid,
               ARRAY[g.gtin] AS gtins,
               a.description AS amp_name, a.invalid AS amp_invalid,
               v.id AS vmp_id, v.name AS vmp_name, v.invalid AS vmp_invalid,
               to_char(g.start_date, 'YYYY-MM-DD') AS start_date,
               to_char(g.end_date, 'YYYY-MM-DD') AS end_date
          FROM dmd_gtin g
          JOIN dmd_ampp p ON p.id = g.ampp_id
          JOIN dmd_vmpp vp ON vp.id = p.vmpp_id
          JOIN dmd_amp a ON a.id = p.amp_id
          JOIN dmd_vmp v ON v.id = a.vmp_id
         WHERE g.gtin = ${gtin14} AND ${IN_FORCE(today)}
         ORDER BY p.invalid, p.name`,
  );
  const names = await lookupNames(tx, packLookups(found));
  return found.map((r) => ({
    pack: packOf(r, names),
    amp: { id: String(r.amp_id), name: r.amp_name, invalid: r.amp_invalid },
    vmp: { id: r.vmp_id, name: r.vmp_name, invalid: r.vmp_invalid },
    startDate: r.start_date,
    endDate: r.end_date,
  }));
}

/** The release history, newest first (rule 1). */
export async function dmdReleaseHistory(tx: Transaction, limit = 50) {
  const found = await rows<{
    id: string;
    name: string;
    released_on: string;
    source: "nhsbsa_trud" | "fixture" | "manual";
    status: "loaded" | "refused" | "failed";
    started_at: Date;
    finished_at: Date;
    file_counts: Record<string, number>;
    changes: Record<string, number>;
    problems: { code: string; file: string | null; id: string | null; message: string }[];
    problem_count: number;
  }>(
    tx,
    sql`SELECT id, name, to_char(released_on, 'YYYY-MM-DD') AS released_on, source, status,
               started_at, finished_at, file_counts, changes, problems, problem_count
          FROM dmd_release WHERE status <> 'loading'
         ORDER BY started_at DESC, id DESC LIMIT ${limit}`,
  );
  return found.map((r) => ({
    id: r.id,
    name: r.name,
    releasedOn: r.released_on,
    source: r.source,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: new Date(r.finished_at).toISOString(),
    fileCounts: r.file_counts,
    changes: r.changes,
    problems: r.problems.map((p) => ({
      code: p.code,
      file: p.file ?? null,
      id: p.id ?? null,
      message: p.message,
    })),
    problemCount: r.problem_count,
  }));
}
