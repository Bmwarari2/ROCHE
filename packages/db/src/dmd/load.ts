import {
  checkDmdRelease,
  DMD_FIXTURE_ENVIRONMENTS,
  DMD_PROBLEMS_KEPT,
  type DmdReleaseContent,
  type DmdReleaseFiles,
  type DmdReleaseProblem,
  type DmdReleaseProblemCode,
  dmdGtinKey,
  dmdLookupKey,
  dmdReleaseDateProblem,
  dmdReleaseOrder,
  isDmdFixtureRelease,
  ukDateOf,
} from "@harbour/domain";
import type pg from "pg";
import { DMD_LOAD_LIMITS, type DmdLoadLimits } from "./files";
import { DmdLoadTimeout, parseDmdRelease } from "./parse";

/**
 * The dm+d release loader (integrations.md section 11 rules 1 to 4; ADR-0080; HZ-113). It reads
 * the release, checks it whole (`checkDmdRelease`), and writes it in one transaction through the
 * loader functions of migration 0110 (owned by `harbour_dmd_loader`; the connecting role needs
 * only EXECUTE: `harbour_worker` for the job, `harbour_owner` for a manual run). Loading the same
 * release again changes nothing; an older release, a broken one or one that lacks a concept in use
 * is refused whole, recorded in the release history with its problems, and the release in use
 * stays as it was. The invented fixture loads only into a database marked for development or tests
 * (`app.database_environment`), a release dated ahead of today is refused, and the whole load runs
 * within its limits (files, bytes, time), reading each file in chunks. Logs and messages carry dm+d
 * identifiers only: dm+d holds no personal data.
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
  /** Files, bytes and time (default `DMD_LOAD_LIMITS`). */
  readonly limits?: DmdLoadLimits;
  /** Now, for the time limit and the release date's future bound (tests). */
  readonly now?: () => Date;
}

const LOADER_REFUSALS = new Set<DmdReleaseProblemCode>([
  "older_than_current",
  "concepts_missing",
  "dated_in_future",
  "fixture_not_allowed",
]);

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
  const code = hint.slice(4) as DmdReleaseProblemCode;
  return LOADER_REFUSALS.has(code) ? code : null;
}

/** What this database is for (`app.database_environment`), or null when it is not marked. */
export async function dmdDatabaseEnvironment(pool: pg.Pool): Promise<string | null> {
  const { rows } = await pool.query<{ environment: string }>(
    "SELECT environment FROM app.database_environment",
  );
  return rows[0]?.environment ?? null;
}

async function recordRefusal(
  pool: pg.Pool,
  release: DmdReleaseFiles,
  status: "refused" | "failed",
  checksum: string | null,
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
  const limits = options.limits ?? DMD_LOAD_LIMITS;
  const now = options.now ?? (() => new Date());
  const deadline = now().getTime() + limits.timeoutMs;
  let fileCounts: Readonly<Record<string, number>> = {};
  let checksum: string | null = null;
  const base = () => ({ name: release.name, releasedOn: release.releasedOn, fileCounts });
  const refuse = async (
    status: "refused" | "failed",
    problems: readonly DmdReleaseProblem[],
    problemCount: number,
  ): Promise<DmdLoadOutcome> => {
    const releaseId = await recordRefusal(
      pool,
      release,
      status,
      checksum,
      fileCounts,
      problems,
      problemCount,
    );
    return { ...base(), status, releaseId, changes: {}, problems, problemCount };
  };
  const refusal = (code: DmdReleaseProblemCode, message: string): DmdReleaseProblem => ({
    code,
    file: null,
    id: null,
    message,
  });

  // The invented fixture never reaches a database where real people work (HZ-113).
  if (isDmdFixtureRelease(release)) {
    const environment = await dmdDatabaseEnvironment(pool);
    if (environment === null || !DMD_FIXTURE_ENVIRONMENTS.includes(environment)) {
      return refuse(
        "refused",
        [
          refusal(
            "fixture_not_allowed",
            `The invented fixture loads only into a database marked dev or test; this one is marked ${environment ?? "nothing"}.`,
          ),
        ],
        1,
      );
    }
  }
  const dateProblem = dmdReleaseDateProblem(release.releasedOn, ukDateOf(now()));
  if (dateProblem === "bad_release") {
    // The history needs a real date: a source that gives none is broken, and the job says so.
    throw new Error(`The dm+d release ${release.name} has no real release date.`);
  }
  if (dateProblem === "dated_in_future") {
    return refuse(
      "refused",
      [refusal("dated_in_future", "The release is dated ahead of today.")],
      1,
    );
  }

  let parsed: Awaited<ReturnType<typeof parseDmdRelease>>;
  try {
    parsed = await parseDmdRelease(release, {
      maxFiles: limits.maxFiles,
      maxBytes: limits.maxBytes,
      deadline,
    });
  } catch (error) {
    if (!(error instanceof DmdLoadTimeout)) throw error;
    return refuse("failed", [refusal("timed_out", timedOut(limits))], 1);
  }
  fileCounts = parsed.fileCounts;
  checksum = parsed.checksum;
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
  const alreadyLoaded = (): DmdLoadOutcome => ({
    ...base(),
    status: "already_loaded",
    releaseId: null,
    changes: {},
    problems: [],
    problemCount: 0,
  });
  if (order === "already_loaded") return alreadyLoaded();
  if (order === "older_than_current") {
    return refuse(
      "refused",
      [refusal("older_than_current", "The release is dated before the release in use.")],
      1,
    );
  }

  const client = await pool.connect();
  /** Each statement may run only for the time the load has left. */
  const timed = async <T extends pg.QueryResultRow>(text: string, values: unknown[]) => {
    const left = deadline - now().getTime();
    if (left <= 0) throw new DmdLoadTimeout();
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(left)]);
    return client.query<T>(text, values);
  };
  try {
    await client.query("BEGIN");
    const { rows } = await timed<{ id: string | null }>(
      "SELECT app.dmd_begin_release($1, $2::date, $3, $4, $5::jsonb) AS id",
      [release.name, release.releasedOn, release.source, checksum, JSON.stringify(fileCounts)],
    );
    const releaseId = rows[0]?.id ?? null;
    if (releaseId === null) {
      // Loaded by another run since the check above.
      await client.query("ROLLBACK");
      return alreadyLoaded();
    }
    for (const [kind, rowsOfKind] of rowsByKind(parsed.content)) {
      for (let i = 0; i < rowsOfKind.length; i += batchSize) {
        await timed("SELECT app.dmd_load_rows($1, $2, $3::jsonb)", [
          releaseId,
          kind,
          JSON.stringify(rowsOfKind.slice(i, i + batchSize)),
        ]);
      }
    }
    // The database works out what the release holds and changed from the rows written.
    const { rows: finished } = await timed<{ changes: Record<string, number> }>(
      "SELECT app.dmd_finish_release($1) AS changes",
      [releaseId],
    );
    await client.query("COMMIT");
    return {
      ...base(),
      status: "loaded",
      releaseId,
      changes: finished[0]?.changes ?? {},
      problems: [],
      problemCount: 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const code = refusalCode(error);
    if (code !== null) {
      const detail = (error as { detail?: unknown }).detail;
      const message = `${(error as Error).message}${typeof detail === "string" && detail ? ` ${detail}` : ""}`;
      return refuse("refused", [refusal(code, message.slice(0, 500))], 1);
    }
    const sqlState = String((error as { code?: unknown }).code ?? "unknown");
    if (error instanceof DmdLoadTimeout || sqlState === "57014") {
      return refuse("failed", [refusal("timed_out", timedOut(limits))], 1);
    }
    // Only the database's error code: its message could quote a row.
    const message = `The load failed in the database (${sqlState}); the release in use is unchanged.`;
    return refuse("failed", [refusal("load_failed", message)], 1);
  } finally {
    client.release();
  }
}

const timedOut = (limits: DmdLoadLimits) =>
  `The load took longer than ${Math.round(limits.timeoutMs / 60_000)} minutes and was stopped; the release in use is unchanged.`;
