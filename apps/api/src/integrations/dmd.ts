import { existsSync } from "node:fs";
import {
  DMD_LOAD_LIMITS,
  type DmdLoadLimits,
  dmdFixtureReleaseDirectories,
  readDmdReleaseDirectory,
} from "@harbour/db/dmd";
import type { DmdReleaseFiles, DmdReleaseSourcePort, HealthResult } from "@harbour/domain";
import { TrudDmdReleaseSource, type TrudOptions } from "./trud";

/**
 * Adapters for the dm+d release source port (integrations.md section 11; ADR-0080). Development
 * and tests use the mock (the invented fixture releases); where real people work, the TRUD adapter
 * (`./trud.ts`, slice 75) when its key is set, and otherwise no source, which the job says rather
 * than loading nothing silently.
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

/** Where real people work and no TRUD API key is set: no release, said rather than silent. */
export class UnconfiguredDmdReleaseSource implements DmdReleaseSourcePort {
  readonly provider = "unconfigured";
  async latest(): Promise<DmdReleaseFiles | null> {
    return null;
  }
  async health(): Promise<HealthResult> {
    return {
      ok: false,
      detail: "No dm+d release source is configured: TRUD_API_KEY is not set (H-1240).",
    };
  }
}

/**
 * The only environments where the invented fixture may be served: a developer's machine, CI and
 * the shared dev environment (`HARBOUR_ENV` unset means a developer's machine). Anything else is
 * where real people may work, so a new environment's name fails safe (security review of slice
 * 75, L4; HZ-113).
 */
const FIXTURE_ENVIRONMENTS = new Set(["", "local", "ci", "dev", "development", "test"]);

/** Whether real people may work here: then never the fixture, and a missing release is late. */
export function realPeopleEnvironment(options: {
  readonly production: boolean;
  readonly environment?: string | undefined;
}): boolean {
  return (
    options.production || !FIXTURE_ENVIRONMENTS.has(options.environment?.trim().toLowerCase() ?? "")
  );
}

/**
 * The source for this process (integrations.md section 11, "Release download" rule 8): the mock
 * only on a developer's machine, CI or the shared dev environment; with `NODE_ENV=production`, or
 * `HARBOUR_ENV` naming staging, pilot or production whatever `NODE_ENV` says, the TRUD adapter
 * when its API key is set, and otherwise no source.
 */
export function createDmdReleaseSource(options: {
  production: boolean;
  environment?: string | undefined;
  limits?: Pick<DmdLoadLimits, "maxFiles" | "maxBytes">;
  trud?: Omit<TrudOptions, "apiKey" | "limits"> & {
    readonly apiKey?: string | undefined;
    readonly maxArchiveBytes: number;
  };
}): DmdReleaseSourcePort {
  if (!realPeopleEnvironment(options)) return new MockDmdReleaseSource(undefined, options.limits);
  const { trud } = options;
  if (!trud?.apiKey) return new UnconfiguredDmdReleaseSource();
  const limits = options.limits ?? DMD_LOAD_LIMITS;
  return new TrudDmdReleaseSource({
    ...trud,
    apiKey: trud.apiKey,
    // Never plain HTTP where real people work, whatever the caller passed.
    allowHttp: false,
    limits: {
      maxFiles: limits.maxFiles,
      maxBytes: limits.maxBytes,
      maxArchiveBytes: trud.maxArchiveBytes,
    },
  });
}

/** The TRUD settings from the configuration (slice 75). */
export function trudSettings(config: {
  readonly TRUD_API_KEY?: string | undefined;
  readonly TRUD_BASE_URL: string;
  readonly TRUD_DMD_ITEM: number;
  readonly TRUD_ALLOWED_HOSTS: readonly string[];
  readonly DMD_ARCHIVE_MAX_BYTES: number;
  readonly DMD_WORK_DIR?: string | undefined;
  readonly DMD_LOAD_TIMEOUT_MINUTES: number;
}) {
  return {
    apiKey: config.TRUD_API_KEY,
    baseUrl: config.TRUD_BASE_URL,
    item: config.TRUD_DMD_ITEM,
    allowedHosts: config.TRUD_ALLOWED_HOSTS,
    maxArchiveBytes: config.DMD_ARCHIVE_MAX_BYTES,
    ...(config.DMD_WORK_DIR ? { workDir: config.DMD_WORK_DIR } : {}),
    timeoutMs: config.DMD_LOAD_TIMEOUT_MINUTES * 60_000,
  };
}
