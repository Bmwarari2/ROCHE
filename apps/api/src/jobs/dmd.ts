import { type DmdLoadOutcome, loadDmdRelease } from "@harbour/db/dmd";
import type { DmdReleaseSourcePort } from "@harbour/domain";
import type pg from "pg";
import type { Logger } from "../logger";

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
 * use changes nothing, so the job may run as often as it likes. Logs carry the release's name,
 * date, counts and problem codes: dm+d holds no personal data.
 */
export async function loadLatestDmdRelease(deps: {
  readonly workerPool: pg.Pool;
  readonly logger: Logger;
  readonly source: DmdReleaseSourcePort;
}): Promise<DmdLoadOutcome | null> {
  const release = await deps.source.latest();
  if (release === null) {
    deps.logger.warn(
      { event: DMD_EVENTS.none, provider: deps.source.provider },
      "No dm+d release to load",
    );
    return null;
  }
  const outcome = await loadDmdRelease(deps.workerPool, release);
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
