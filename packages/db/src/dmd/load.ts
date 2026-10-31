import {
  checkDmdRelease,
  DMD_PROBLEMS_KEPT,
  type DmdReleaseContent,
  type DmdReleaseFiles,
  type DmdReleaseProblem,
  type DmdReleaseProblemCode,
  dmdGtinKey,
  dmdLookupKey,
  dmdReleaseOrder,
} from "@harbour/domain";
import type pg from "pg";
import { parseDmdRelease } from "./parse";

/**
 * The dm+d release loader (integrations.md section 11 rules 1 to 4; ADR-0080; HZ-113). It reads
 * the release, checks it whole (`checkDmdRelease`), and writes it in one transaction through the
 * loader functions of migration 0110 (owned by `harbour_dmd_loader`; the connecting role needs
 * only EXECUTE: `harbour_worker` for the job, `harbour_owner` for a manual run). Loading the same
 * release again changes nothing; an older release, a broken one or one that lacks a concept in use
 * is refused whole, recorded in the release history with its problems, and the release in use
 * stays as it was. Logs and messages carry dm+d identifiers only: dm+d holds no personal data.
 */

export type DmdLoadStatus = "loaded" | "already_loaded" | "refused" | "failed";

export interface DmdLoadOutcome {
  readonly status: DmdLoadStatus;
  /** The release history row written (none when the release was already loaded). */
  readonly releaseId: string | null;
  readonly name: string;
  readonly releasedOn: string;
  readonly fileCounts: Readonly<Record<string, number>>;
  /** What the load added, changed, invalidated, superseded and withdrew. */
  readonly changes: Readonly<Record<string, number>>;
  readonly problems: readonly DmdReleaseProblem[];
  readonly problemCount: number;
}

export interface DmdLoadOptions {
  /** Rows per call of `app.dmd_load_rows` (default 2000). */
  readonly batchSize?: number;
}

type Row = Record<string, unknown>;

/** The rows of each file as `app.dmd_load_rows` takes them, in the order references need. */
function rowsByKind(content: DmdReleaseContent): [string, Row[]][] {
  return [
    [
      "lookup",
      content.lookups.map((e) => ({
        id: dmdLookupKey(e),
        kind: e.kind,
        code: e.code,
        description: e.description,
        previous_code: e.previousCode,
      })),
    ],
    [
      "vtm",
      content.vtms.map((v) => ({
        id: v.id,
        name: v.name,
        abbreviated_name: v.abbreviatedName,
        invalid: v.invalid,
        previous_id: v.previousId,
      })),
    ],
    [
      "vmp",
      content.vmps.map((v) => ({
        id: v.id,
        vtm_id: v.vtmId,
        name: v.name,
        abbreviated_name: v.abbreviatedName,
        invalid: v.invalid,
        previous_id: v.previousId,
        unit_dose_uom_code: v.unitDoseUomCode,
        udfs: v.udfs,
        udfs_uom_code: v.udfsUomCode,
        strength_uom_codes: v.strengthUomCodes,
        form_code: v.formCode,
        route_codes: v.routeCodes,
        control_drug_category_code: v.controlDrugCategoryCode,
      })),
    ],
    [
      "amp",
      content.amps.map((a) => ({
        id: a.id,
        vmp_id: a.vmpId,
        name: a.name,
        abbreviated_name: a.abbreviatedName,
        description: a.description,
        invalid: a.invalid,
        licensed_route_codes: a.licensedRouteCodes,
      })),
    ],
    [
      "vmpp",
      content.vmpps.map((v) => ({
        id: v.id,
        vmp_id: v.vmpId,
        name: v.name,
        quantity: v.quantity,
        quantity_uom_code: v.quantityUomCode,
        invalid: v.invalid,
      })),
    ],
    [
      "ampp",
      content.ampps.map((a) => ({
        id: a.id,
        vmpp_id: a.vmppId,
        amp_id: a.ampId,
        name: a.name,
        abbreviated_name: a.abbreviatedName,
        legal_category_code: a.legalCategoryCode,
        discontinued: a.discontinued,
        discontinued_on: a.discontinuedOn,
        invalid: a.invalid,
      })),
    ],
    [
      "gtin",
      content.gtins.map((g) => ({
        id: dmdGtinKey(g),
        ampp_id: g.amppId,
        gtin: g.gtin,
        start_date: g.startDate,
        end_date: g.endDate,
      })),
    ],
  ];
}

/** A refusal the loader functions raise carries its problem code as `dmd:<code>` in the hint. */
function refusalCode(error: unknown): DmdReleaseProblemCode | null {
  const hint = (error as { hint?: unknown }).hint;
  if (typeof hint !== "string" || !hint.startsWith("dmd:")) return null;
  const code = hint.slice(4);
  return code === "older_than_current" || code === "concepts_missing" ? code : null;
}

async function recordRefusal(
  pool: pg.Pool,
  release: DmdReleaseFiles,
  status: "refused" | "failed",
  checksum: string,
  fileCounts: Readonly<Record<string, number>>,
  problems: readonly DmdReleaseProblem[],
  problemCount: number,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT app.dmd_record_refusal($1, $2::date, $3, $4, $5, $6::jsonb, $7::jsonb, $8) AS id`,
    [
      release.name.slice(0, 200),
      release.releasedOn,
      release.source,
      status,
      checksum,
      JSON.stringify(fileCounts),
      JSON.stringify(problems.slice(0, DMD_PROBLEMS_KEPT)),
      problemCount,
    ],
  );
  return rows[0]?.id as string;
}

/** Loads one release whole or not at all. */
export async function loadDmdRelease(
  pool: pg.Pool,
  release: DmdReleaseFiles,
  options: DmdLoadOptions = {},
): Promise<DmdLoadOutcome> {
  const batchSize = options.batchSize ?? 2000;
  const parsed = parseDmdRelease(release);
  const base = {
    name: release.name,
    releasedOn: release.releasedOn,
    fileCounts: parsed.fileCounts,
  };
  const refuse = async (
    status: "refused" | "failed",
    problems: readonly DmdReleaseProblem[],
    problemCount: number,
  ): Promise<DmdLoadOutcome> => {
    const releaseId = await recordRefusal(
      pool,
      release,
      status,
      parsed.checksum,
      parsed.fileCounts,
      problems,
      problemCount,
    );
    return { ...base, status, releaseId, changes: {}, problems, problemCount };
  };

  if (parsed.content === null || parsed.problemCount > 0) {
    return refuse("refused", parsed.problems, Math.max(parsed.problemCount, 1));
  }
  const check = checkDmdRelease(parsed.content);
  if (!check.ok) return refuse("refused", check.problems, check.problemCount);

  const { rows: loaded } = await pool.query<{ name: string; released_on: string }>(
    "SELECT name, to_char(released_on, 'YYYY-MM-DD') AS released_on FROM dmd_release WHERE status = 'loaded'",
  );
  const order = dmdReleaseOrder(
    release,
    loaded.map((r) => ({ name: r.name, releasedOn: r.released_on })),
  );
  if (order === "already_loaded") {
    return {
      ...base,
      status: "already_loaded",
      releaseId: null,
      changes: {},
      problems: [],
      problemCount: 0,
    };
  }
  if (order === "older_than_current") {
    const problem: DmdReleaseProblem = {
      code: "older_than_current",
      file: null,
      id: null,
      message: "The release is dated before the release in use.",
    };
    return refuse("refused", [problem], 1);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string | null }>(
      "SELECT app.dmd_begin_release($1, $2::date, $3, $4, $5::jsonb) AS id",
      [
        release.name,
        release.releasedOn,
        release.source,
        parsed.checksum,
        JSON.stringify(parsed.fileCounts),
      ],
    );
    const releaseId = rows[0]?.id ?? null;
    if (releaseId === null) {
      // Loaded by another run since the check above.
      await client.query("ROLLBACK");
      return {
        ...base,
        status: "already_loaded",
        releaseId: null,
        changes: {},
        problems: [],
        problemCount: 0,
      };
    }
    const changes: Record<string, number> = {};
    const ids: Record<string, string[]> = {};
    for (const [kind, rowsOfKind] of rowsByKind(parsed.content)) {
      ids[kind] = rowsOfKind.map((r) => r.id as string);
      for (let i = 0; i < rowsOfKind.length; i += batchSize) {
        const { rows: result } = await client.query<{ counts: Record<string, number> }>(
          "SELECT app.dmd_load_rows($1, $2, $3::jsonb) AS counts",
          [releaseId, kind, JSON.stringify(rowsOfKind.slice(i, i + batchSize))],
        );
        for (const [what, n] of Object.entries(result[0]?.counts ?? {})) {
          changes[`${kind}_${what}`] = (changes[`${kind}_${what}`] ?? 0) + n;
        }
      }
    }
    const { rows: finished } = await client.query<{ changes: Record<string, number> }>(
      "SELECT app.dmd_finish_release($1, $2::jsonb, $3::jsonb) AS changes",
      [releaseId, JSON.stringify(ids), JSON.stringify(changes)],
    );
    await client.query("COMMIT");
    return {
      ...base,
      status: "loaded",
      releaseId,
      changes: finished[0]?.changes ?? changes,
      problems: [],
      problemCount: 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = refusalCode(error);
    if (code !== null) {
      const detail = (error as { detail?: unknown }).detail;
      const message = `${(error as Error).message}${typeof detail === "string" && detail ? ` ${detail}` : ""}`;
      return refuse("refused", [{ code, file: null, id: null, message: message.slice(0, 500) }], 1);
    }
    // Only the database's error code: its message could quote a row.
    const sqlState = String((error as { code?: unknown }).code ?? "unknown");
    const message = `The load failed in the database (${sqlState}); the release in use is unchanged.`;
    return refuse("failed", [{ code: "load_failed", file: null, id: null, message }], 1);
  } finally {
    client.release();
  }
}
