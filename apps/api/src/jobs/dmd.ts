import { type DmdLoadLimits, type DmdLoadOutcome, loadDmdRelease } from "@harbour/db/dmd";
import {
  type DmdReleaseSourcePort,
  dmdReleaseFreshness,
  resolveRate,
  ukDateOf,
} from "@harbour/domain";
import type pg from "pg";
import { TrudError } from "../integrations/trud";
import type { Logger } from "../logger";
import { DMD_STALE_AFTER_KEY } from "../services/dmd";

/** The load's limits from the worker's configuration (ADR-0080; technical bounds, not statutory). */
export function dmdLoadLimits(config: {
  readonly DMD_RELEASE_MAX_FILES: number;
  readonly DMD_RELEASE_MAX_BYTES: number;
  readonly DMD_LOAD_TIMEOUT_MINUTES: number;
}): DmdLoadLimits {
  return {
    maxFiles: config.DMD_RELEASE_MAX_FILES,
    maxBytes: config.DMD_RELEASE_MAX_BYTES,
    timeoutMs: config.DMD_LOAD_TIMEOUT_MINUTES * 60_000,
  };
}

/** The shared worker's old monthly dm+d queue, unscheduled since the load is its own job (slice 75). */
export const RETIRED_DMD_QUEUE = "dmd-release-load";

/**
 * The structured log lines of the dm+d job and the worker's daily check. The operator is alerted
 * on `refused`, `failed`, `download_failed` and `late` (integrations.md section 11, "Release
 * download" rule 7; HZ-113; the alert policies are H-1241).
 */
export const DMD_EVENTS = {
  none: "dmd.release.none",
  loaded: "dmd.release.loaded",
  already_loaded: "dmd.release.already_loaded",
  refused: "dmd.release.refused",
  failed: "dmd.release.failed",
  download_failed: "dmd.download.failed",
  late: "dmd.release.late",
  current: "dmd.release.current",
} as const;

/**
 * The dm+d release job (integrations.md section 11; ADR-0080): asks the source for its latest
 * release and loads it as the dm+d job's own role, through the loader's functions. Loading a release already in
 * use changes nothing, so the job may run as often as it likes. It runs within its limits (files,
 * bytes, time), reading each file in chunks and yielding between them, on its own queue that holds
 * one job at a time, so it never holds up the outbox or escalations for long. A process of its own
 * for the load is slice 75's (STATUS). Logs carry the release's name, date, counts and problem
 * codes: dm+d holds no personal data.
 */
export async function loadLatestDmdRelease(deps: {
  /** The dm+d job's own role (harbour_dmd_job, migration 0131): the loader runs as it. */
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly source: DmdReleaseSourcePort;
  readonly limits?: DmdLoadLimits;
}): Promise<DmdLoadOutcome | null> {
  const release = await deps.source.latest();
  if (release === null) {
    deps.logger.warn(
      { event: DMD_EVENTS.none, provider: deps.source.provider },
      "No dm+d release to load",
    );
    return null;
  }
  const outcome = await loadDmdRelease(
    deps.pool,
    release,
    deps.limits ? { limits: deps.limits } : {},
  );
  const line = {
    event: DMD_EVENTS[outcome.status],
    provider: deps.source.provider,
    release: outcome.name,
    releasedOn: outcome.releasedOn,
    changes: outcome.changes,
    problemCount: outcome.problemCount,
    problems: outcome.problems.slice(0, 5).map((p) => p.code),
  };
  if (outcome.status === "refused" || outcome.status === "failed") {
    deps.logger.error(line, "dm+d release not loaded");
  } else {
    deps.logger.info(line, "dm+d release job finished");
  }
  return outcome;
}

/** Whether a release under this name is already loaded (the release history; national data). */
async function releaseLoaded(pool: pg.Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ loaded: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM dmd_release WHERE name = $1 AND status = 'loaded') AS loaded",
    [name],
  );
  return rows[0]?.loaded === true;
}

/**
 * One run of the dm+d job (integrations.md section 11, "Release download"; slice 75), as its own
 * Cloud Run job: asks the source what its latest release is, skips one already loaded without
 * downloading it, otherwise downloads and loads it, and deletes what it downloaded. Exit status 1
 * when the release is refused or fails, or cannot be downloaded, so the job's execution fails too.
 */
export async function runDmdReleaseJob(deps: {
  /** The dm+d job's own role (harbour_dmd_job, migration 0131). */
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly source: DmdReleaseSourcePort;
  readonly limits?: DmdLoadLimits;
  /** True where real people work: no source, or no release, is then a failure (review M1). */
  readonly expected?: boolean;
}): Promise<{ readonly exitCode: 0 | 1; readonly outcome: DmdLoadOutcome | null }> {
  if (deps.expected && deps.source.provider === "unconfigured") {
    deps.logger.error(
      {
        event: DMD_EVENTS.download_failed,
        provider: deps.source.provider,
        code: "trud_unconfigured",
      },
      "dm+d release not downloaded: no TRUD API key is set (H-1240)",
    );
    return { exitCode: 1, outcome: null };
  }
  try {
    const peeked = deps.source.peek ? await deps.source.peek() : null;
    if (peeked && (await releaseLoaded(deps.pool, peeked.name))) {
      deps.logger.info(
        {
          event: DMD_EVENTS.already_loaded,
          provider: deps.source.provider,
          release: peeked.name,
          releasedOn: peeked.releasedOn,
          downloaded: false,
        },
        "dm+d release already loaded: not downloaded again",
      );
      return { exitCode: 0, outcome: null };
    }
    const outcome = await loadLatestDmdRelease(deps);
    const bad =
      outcome?.status === "refused" ||
      outcome?.status === "failed" ||
      (outcome === null && deps.expected === true);
    return { exitCode: bad ? 1 : 0, outcome };
  } catch (error) {
    // A code and an HTTP status only: an address or a message may carry the API key.
    deps.logger.error(
      {
        event: DMD_EVENTS.download_failed,
        provider: deps.source.provider,
        code: error instanceof TrudError ? error.code : "unexpected",
        ...(error instanceof TrudError && error.status !== undefined
          ? { status: error.status }
          : {}),
        ...(error instanceof TrudError
          ? {}
          : { err: { name: error instanceof Error ? error.name : "Error" } }),
      },
      "dm+d release not downloaded",
    );
    return { exitCode: 1, outcome: null };
  } finally {
    await deps.source.close?.().catch(() => undefined);
  }
}

/**
 * The worker's daily dm+d check (rule 7; HZ-113): the release in use and its age against
 * `medicines.dmd.stale_after_days`, the figure every screen uses. Logs `dmd.release.late` (an
 * alert) when it is out of date, or when none is loaded where real people work (`expected`).
 */
export async function checkDmdFreshness(deps: {
  readonly workerPool: pg.Pool;
  readonly logger: Logger;
  /** True where real people work: no release at all is then late too. */
  readonly expected: boolean;
  readonly now?: Date;
}): Promise<{ readonly late: boolean; readonly status: string; readonly ageDays: number | null }> {
  const today = ukDateOf(deps.now ?? new Date());
  const rates = await deps.workerPool.query(
    `SELECT key, value, unit, nation, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
            to_char(valid_to, 'YYYY-MM-DD') AS valid_to, source, verification_status
       FROM rate_table WHERE key = $1 AND tenant_id IS NULL`,
    [DMD_STALE_AFTER_KEY],
  );
  const staleAfterDays = resolveRate(
    rates.rows.map((r) => ({
      key: String(r.key),
      value: Number(r.value),
      unit: String(r.unit),
      nation: String(r.nation),
      validFrom: String(r.valid_from),
      validTo: r.valid_to === null ? null : String(r.valid_to),
      tenantId: null,
      source: String(r.source),
      verificationStatus: String(r.verification_status),
    })),
    DMD_STALE_AFTER_KEY,
    "england",
    today,
    null,
  ).value;
  const { rows } = await deps.workerPool.query<{ name: string; released_on: string }>(
    `SELECT name, to_char(released_on, 'YYYY-MM-DD') AS released_on FROM dmd_release
      WHERE status = 'loaded' ORDER BY released_on DESC, finished_at DESC LIMIT 1`,
  );
  const release = rows[0] ? { name: rows[0].name, releasedOn: rows[0].released_on } : null;
  const freshness = dmdReleaseFreshness(release, today, staleAfterDays);
  const late = freshness.status === "out_of_date" || (freshness.status === "none" && deps.expected);
  const line = {
    event: late ? DMD_EVENTS.late : DMD_EVENTS.current,
    status: freshness.status,
    release: release?.name ?? null,
    releasedOn: release?.releasedOn ?? null,
    ageDays: freshness.ageDays,
    staleAfterDays,
  };
  if (late) deps.logger.error(line, "dm+d release in use is late");
  else deps.logger.info(line, "dm+d release in use checked");
  return { late, status: freshness.status, ageDays: freshness.ageDays };
}
