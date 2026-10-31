import { dmdFixtureReleaseDirectories, parseDmdRelease } from "@harbour/db/dmd";
import {
  checkDmdRelease,
  DMD_RELEASE_SOURCES,
  type DmdReleaseSourcePort,
  dmdReleaseDateFromName,
} from "@harbour/domain";
import { describe, expect, it } from "vitest";
import {
  createDmdReleaseSource,
  MockDmdReleaseSource,
  UnconfiguredDmdReleaseSource,
} from "../src/integrations/dmd";

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
    expect(file.content.length).toBeGreaterThan(0);
  }
  // A whole release: every file present and readable, and every check passed.
  const parsed = parseDmdRelease(release);
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
});
