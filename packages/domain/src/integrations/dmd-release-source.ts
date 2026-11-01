/**
 * The dm+d release source port (integrations.md section 11; INTG-006; ADR-0080). The worker asks
 * the source for the latest release and loads it through the release loader (slice 10). Slice 75
 * builds the TRUD adapter (download with credentials from the secret store, checksum, monthly
 * schedule, failure alert); until then the mock serves the invented fixture release, and in
 * production no source is configured, which the job says rather than loading nothing silently.
 *
 * A national download: no tenant, and nothing about anyone leaves Harbour (TRUD receives only the
 * account's credentials).
 */

import type { HealthResult } from "./ports";

/** Where a release came from, as the release history records it. */
export const DMD_RELEASE_SOURCES = ["nhsbsa_trud", "fixture", "manual"] as const;
export type DmdReleaseSourceKind = (typeof DMD_RELEASE_SOURCES)[number];

/**
 * One file of a release, as published (for example `f_vmp2_3261026.xml`), read in chunks as the
 * loader needs it, never whole: a real release runs to hundreds of megabytes.
 */
export interface DmdReleaseFileSource {
  readonly name: string;
  /** Its size in bytes, checked against the loader's limits before anything is read. */
  readonly bytes: number;
  /** The file's text, decoded as UTF-8, in chunks; never more than `bytes`. */
  chunks(): AsyncIterable<string>;
}

/** A release's files with its name and date, as the source publishes them. */
export interface DmdReleaseFiles {
  /** The release's own name, for example `nhsbsa_dmd_10.1.0_20261026000001`. */
  readonly name: string;
  /** YYYY-MM-DD. */
  readonly releasedOn: string;
  readonly source: DmdReleaseSourceKind;
  readonly files: readonly DmdReleaseFileSource[];
}

export interface DmdReleaseSourcePort {
  readonly provider: string;
  /**
   * The latest release's name and date without fetching its files, when the source can tell
   * (TRUD): the job skips a release already loaded rather than downloading it again (slice 75).
   */
  peek?(): Promise<{ readonly name: string; readonly releasedOn: string } | null>;
  /** The latest release the source publishes, or null when it has none. */
  latest(): Promise<DmdReleaseFiles | null>;
  /** Deletes whatever `latest` downloaded or unpacked; the job calls it when the load is over. */
  close?(): Promise<void>;
  health(): Promise<HealthResult>;
}
