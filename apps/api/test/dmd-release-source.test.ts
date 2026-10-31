import {
  DMD_LOAD_LIMITS,
  DmdReleaseFileError,
  dmdFixtureReleaseDirectories,
  parseDmdRelease,
} from "@harbour/db/dmd";
import {
  checkDmdRelease,
  DMD_RELEASE_SOURCES,
  type DmdReleaseSourcePort,
  dmdReleaseDateFromName,
} from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  createDmdReleaseSource,
  MockDmdReleaseSource,
  UnconfiguredDmdReleaseSource,
} from "../src/integrations/dmd";
import { DMD_WORK_OPTIONS, dmdLoadLimits, dmdQueueOptions } from "../src/jobs/dmd";

/**
 * The dm+d release source port's contract (integrations.md sections 4 and 11; ADR-0080): what
 * every adapter must give the loader. The mock passes it now; slice 75's TRUD adapter must pass it
 * against a mock TRUD before it is switched on. No database and no network.
 */

async function honoursContract(port: DmdReleaseSourcePort): Promise<void> {
  expect(port.provider).toMatch(/^[a-z_]+$/);
  const health = await port.health();
  expect(typeof health.ok).toBe("boolean");
  expect(health.detail.length).toBeGreaterThan(10);
  const release = await port.latest();
  if (release === null) return;
  // The name carries the date, and the date given is that one.
  expect(dmdReleaseDateFromName(release.name)).toBe(release.releasedOn);
  expect(DMD_RELEASE_SOURCES).toContain(release.source);
  for (const file of release.files) {
    expect(file.name).toMatch(/^[\w.-]+\.xml$/);
    expect(file.bytes).toBeGreaterThan(0);
    // Read in chunks, never more than it says.
    let bytes = 0;
    for await (const chunk of file.chunks()) bytes += Buffer.byteLength(chunk, "utf8");
    expect(bytes).toBe(file.bytes);
  }
  // A whole release: every file present and readable, and every check passed.
  const parsed = await parseDmdRelease(release, {
    maxFiles: DMD_LOAD_LIMITS.maxFiles,
    maxBytes: DMD_LOAD_LIMITS.maxBytes,
    deadline: Date.now() + 60_000,
  });
  expect(parsed.problems).toEqual([]);
  expect(parsed.content).not.toBeNull();
  if (parsed.content) expect(checkDmdRelease(parsed.content).problems).toEqual([]);
}

describe("the dm+d release source port (contract)", () => {
  it("is honoured by the mock, which serves the newest fixture release", async () => {
    const mock = new MockDmdReleaseSource();
    await honoursContract(mock);
    const newest = dmdFixtureReleaseDirectories().at(-1) ?? "";
    expect((await mock.latest())?.name).toBe(newest.split("/").at(-1));
    expect((await mock.health()).ok).toBe(true);
  });

  it("is honoured by the unconfigured source, which has no release and says so", async () => {
    const none = new UnconfiguredDmdReleaseSource();
    await honoursContract(none);
    expect(await none.latest()).toBeNull();
    expect((await none.health()).ok).toBe(false);
  });

  it("has no release when the mock finds no fixture (a built bundle)", async () => {
    const empty = new MockDmdReleaseSource(["/nowhere/fixture_dmd_1.0.0_20261005000001"]);
    expect(await empty.latest()).toBeNull();
    expect((await empty.health()).ok).toBe(false);
  });

  it("hazard HZ-113 never serves the invented fixture where real people may work", () => {
    expect(createDmdReleaseSource({ production: true }).provider).toBe("unconfigured");
    for (const environment of ["staging", "pilot", "production", " Pilot "]) {
      expect(createDmdReleaseSource({ production: false, environment }).provider).toBe(
        "unconfigured",
      );
    }
    expect(createDmdReleaseSource({ production: false }).provider).toBe("mock");
    expect(createDmdReleaseSource({ production: false, environment: "dev" }).provider).toBe("mock");
  });

  it("hazard HZ-113 the mock reads within the load's limits", async () => {
    const tight = new MockDmdReleaseSource(undefined, { maxFiles: 64, maxBytes: 1000 });
    await expect(tight.latest()).rejects.toThrow(DmdReleaseFileError);
  });
});

describe("hazard HZ-113 the dm+d job's limits and queue (security review)", () => {
  it("takes its limits from configuration, with bounds", () => {
    const defaults = loadConfig({ NODE_ENV: "test" });
    expect(dmdLoadLimits(defaults)).toEqual({
      maxFiles: 64,
      maxBytes: 2 * 1024 ** 3,
      timeoutMs: 60 * 60_000,
    });
    const set = loadConfig({
      NODE_ENV: "test",
      DMD_RELEASE_MAX_FILES: "20",
      DMD_RELEASE_MAX_BYTES: "1048576",
      DMD_LOAD_TIMEOUT_MINUTES: "5",
    });
    expect(dmdLoadLimits(set)).toEqual({ maxFiles: 20, maxBytes: 1048576, timeoutMs: 300_000 });
    for (const [key, value] of [
      ["DMD_RELEASE_MAX_FILES", "3"],
      ["DMD_RELEASE_MAX_BYTES", "10"],
      ["DMD_LOAD_TIMEOUT_MINUTES", "0"],
      ["DMD_LOAD_TIMEOUT_MINUTES", "1000"],
    ] as const) {
      expect(() => loadConfig({ NODE_ENV: "test", [key]: value }), key).toThrow();
    }
  });

  it("runs on its own queue, one job at a time, expiring only after its time limit", () => {
    expect(dmdQueueOptions(60)).toEqual({
      policy: "exclusive",
      expireInSeconds: 3900,
      retryLimit: 1,
    });
    expect(DMD_WORK_OPTIONS).toEqual({ localConcurrency: 1, batchSize: 1 });
  });
});
