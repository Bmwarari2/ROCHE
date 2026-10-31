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

/** One file of a release, as published (for example `f_vmp2_3261026.xml`). */
export interface DmdReleaseFileContent {
  readonly name: string;
  readonly content: string;
}

/** A release's files with its name and date, as the source publishes them. */
export interface DmdReleaseFiles {
  /** The release's own name, for example `nhsbsa_dmd_10.1.0_20261026000001`. */
  readonly name: string;
  /** YYYY-MM-DD. */
  readonly releasedOn: string;
  readonly source: DmdReleaseSourceKind;
  readonly files: readonly DmdReleaseFileContent[];
}

export interface DmdReleaseSourcePort {
  readonly provider: string;
  /** The latest release the source publishes, or null when it has none. */
  latest(): Promise<DmdReleaseFiles | null>;
  health(): Promise<HealthResult>;
}
