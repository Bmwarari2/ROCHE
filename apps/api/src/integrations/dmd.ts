import { existsSync } from "node:fs";
import {
  DMD_LOAD_LIMITS,
  type DmdLoadLimits,
  dmdFixtureReleaseDirectories,
  readDmdReleaseDirectory,
} from "@harbour/db/dmd";
import type { DmdReleaseFiles, DmdReleaseSourcePort, HealthResult } from "@harbour/domain";

/**
 * Adapters for the dm+d release source port (integrations.md section 11; ADR-0080). The TRUD
 * adapter is slice 75; until it lands, development and tests use the mock (the invented fixture
 * releases) and production has no source, which the job says rather than loading nothing silently.
 * The database itself refuses the fixture unless it is marked dev or test (migration 0110).
 */

/** Serves the newest invented fixture release. Never touches the network; never in production. */
export class MockDmdReleaseSource implements DmdReleaseSourcePort {
  readonly provider = "mock";
  constructor(
    private readonly directories?: readonly string[],
    private readonly limits: Pick<DmdLoadLimits, "maxFiles" | "maxBytes"> = DMD_LOAD_LIMITS,
  ) {}

  private releases(): readonly string[] {
    try {
      return (this.directories ?? dmdFixtureReleaseDirectories()).filter((d) => existsSync(d));
    } catch {
      // A built bundle carries no fixtures.
      return [];
    }
  }

  async latest(): Promise<DmdReleaseFiles | null> {
    const newest = this.releases().at(-1);
    return newest === undefined ? null : readDmdReleaseDirectory(newest, "fixture", this.limits);
  }

  async health(): Promise<HealthResult> {
    return this.releases().length > 0
      ? { ok: true, detail: "Mock adapter: serves the invented fixture release." }
      : { ok: false, detail: "Mock adapter: no fixture release is available." };
  }
}

/** Production until slice 75 builds the TRUD download. */
export class UnconfiguredDmdReleaseSource implements DmdReleaseSourcePort {
  readonly provider = "unconfigured";
  async latest(): Promise<DmdReleaseFiles | null> {
    return null;
  }
  async health(): Promise<HealthResult> {
    return {
      ok: false,
      detail:
        "No dm+d release source is configured: the TRUD download is not built yet (slice 75).",
    };
  }
}

/** Shared environments where real people may work: never the invented fixture (HZ-113). */
const NO_FIXTURE_ENVIRONMENTS = new Set(["staging", "pilot", "production", "prod"]);

/**
 * The source for this process: the mock only on a developer's machine, CI or the shared dev
 * environment; with `NODE_ENV=production`, or `HARBOUR_ENV` naming staging, pilot or production
 * whatever `NODE_ENV` says, no source until the TRUD adapter (slice 75).
 */
export function createDmdReleaseSource(options: {
  production: boolean;
  environment?: string | undefined;
  limits?: Pick<DmdLoadLimits, "maxFiles" | "maxBytes">;
}): DmdReleaseSourcePort {
  const shared = NO_FIXTURE_ENVIRONMENTS.has(options.environment?.trim().toLowerCase() ?? "");
  return options.production || shared
    ? new UnconfiguredDmdReleaseSource()
    : new MockDmdReleaseSource(undefined, options.limits);
}
