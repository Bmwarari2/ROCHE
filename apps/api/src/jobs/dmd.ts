import { type DmdLoadLimits, type DmdLoadOutcome, loadDmdRelease } from "@harbour/db/dmd";
import type { DmdReleaseSourcePort } from "@harbour/domain";
import type pg from "pg";
import type { Logger } from "../logger";

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

/**
 * The dm+d queue: one job queued or running at a time (`exclusive`), expiring only after the
 * load's own time limit, retried once. Worked one at a time (`DMD_WORK_OPTIONS`).
 */
export function dmdQueueOptions(timeoutMinutes: number) {
  return {
    policy: "exclusive",
    expireInSeconds: timeoutMinutes * 60 + 300,
    retryLimit: 1,
  } as const;
}
export const DMD_WORK_OPTIONS = { localConcurrency: 1, batchSize: 1 } as const;

/** The structured log lines of the dm+d job; slice 75 alerts on the refused and failed ones (HZ-113). */
export const DMD_EVENTS = {
  none: "dmd.release.none",
  loaded: "dmd.release.loaded",
  already_loaded: "dmd.release.already_loaded",
  refused: "dmd.release.refused",
  failed: "dmd.release.failed",
} as const;

/**
 * The dm+d release job (integrations.md section 11; ADR-0080): asks the source for its latest
 * release and loads it as the worker, through the loader's functions. Loading a release already in
 * use changes nothing, so the job may run as often as it likes. It runs within its limits (files,
 * bytes, time), reading each file in chunks and yielding between them, on its own queue that holds
 * one job at a time, so it never holds up the outbox or escalations for long. A process of its own
 * for the load is slice 75's (STATUS). Logs carry the release's name, date, counts and problem
 * codes: dm+d holds no personal data.
 */
export async function loadLatestDmdRelease(deps: {
  readonly workerPool: pg.Pool;
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
    deps.workerPool,
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
