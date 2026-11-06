import { existsSync } from "node:fs";
import pg from "pg";
import { dmdFixtureReleaseDirectories, loadDmdRelease, readDmdReleaseDirectory } from "../src/dmd";
import { ownerUrl } from "./env";

/**
 * A manual dm+d load (integrations.md section 11; ADR-0080), as harbour_owner:
 *   pnpm --filter @harbour/db dmd:load <release directory>   a release a person downloaded
 *   pnpm --filter @harbour/db dmd:load                       the invented fixture releases
 * The fixture is never loaded in production, staging or pilot (HZ-113): this script refuses it
 * there, and the database refuses it, under any name or source, unless it is marked dev or test
 * (`app.database_environment`). The monthly job (slice 75) runs the same loader as the worker. Prints the outcome with dm+d identifiers only.
 */

const directory = process.argv[2];
const shared = ["staging", "pilot", "production", "prod"].includes(
  (process.env.HARBOUR_ENV ?? "").trim().toLowerCase(),
);
if (directory === undefined && (process.env.NODE_ENV === "production" || shared)) {
  throw new Error(
    "Name the release directory: the invented fixture is never loaded where real people work.",
  );
}
if (directory !== undefined && !existsSync(directory)) {
  throw new Error(`No release directory at ${directory}.`);
}
const releases =
  directory === undefined
    ? await Promise.all(
        dmdFixtureReleaseDirectories().map((d) => readDmdReleaseDirectory(d, "fixture")),
      )
    : [await readDmdReleaseDirectory(directory, "manual")];

const pool = new pg.Pool({ connectionString: ownerUrl(), max: 2 });
try {
  for (const release of releases) {
    const outcome = await loadDmdRelease(pool, release);
    console.log(
      `${outcome.name}: ${outcome.status}`,
      outcome.problemCount > 0 ? outcome.problems : outcome.changes,
    );
  }
} finally {
  await pool.end();
}
