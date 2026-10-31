import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DmdReleaseFiles,
  type DmdReleaseSourceKind,
  dmdReleaseDateFromName,
} from "@harbour/domain";

/**
 * A release on disk: a directory named as the release (`nhsbsa_dmd_10.1.0_20261026000001`) holding
 * its XML files, as a TRUD download unzips (slice 75) or a person places them for a manual run.
 */
export function readDmdReleaseDirectory(
  directory: string,
  source: DmdReleaseSourceKind,
): DmdReleaseFiles {
  const name = basename(directory);
  const releasedOn = dmdReleaseDateFromName(name);
  if (releasedOn === null) {
    throw new Error(`The directory name ${name} does not carry a dm+d release date.`);
  }
  const files = readdirSync(directory)
    .filter((f) => f.endsWith(".xml"))
    .sort()
    .map((f) => ({ name: f, content: readFileSync(join(directory, f), "utf8") }));
  return { name, releasedOn, source, files };
}

/**
 * The invented fixture releases (ADR-0080: development and tests never use real dm+d files), oldest
 * first. Never loaded in production: the mock release source and the manual script use them
 * outside production only.
 */
export function dmdFixtureReleaseDirectories(): string[] {
  const root = fileURLToPath(new URL("../../test/fixtures/dmd/", import.meta.url));
  return readdirSync(root)
    .filter((d) => dmdReleaseDateFromName(d) !== null)
    .sort((a, b) =>
      (dmdReleaseDateFromName(a) ?? "") < (dmdReleaseDateFromName(b) ?? "") ? -1 : 1,
    )
    .map((d) => join(root, d));
}
