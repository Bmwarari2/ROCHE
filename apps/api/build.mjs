import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

// Bundles the API, worker and migrate task (workspace packages included) into single ESM files for
// the container, and copies what they read at run time next to them.
const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  packages: "bundle",
  external: ["pg-native"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
};

await build({ ...shared, entryPoints: ["src/server.ts"], outfile: "dist/server.js" });
await build({ ...shared, entryPoints: ["src/jobs/worker.ts"], outfile: "dist/worker.js" });
await build({ ...shared, entryPoints: ["src/jobs/migrate.ts"], outfile: "dist/migrate.js" });

// The migrator reads the SQL migrations and the reference documents at run time.
mkdirSync("dist/drizzle", { recursive: true });
cpSync("../../packages/db/drizzle", "dist/drizzle", { recursive: true });
copyFileSync("../../docs/specs/rates.md", "dist/rates.md");
copyFileSync("../../docs/specs/calendar.md", "dist/calendar.md");
copyFileSync("../../docs/specs/retention.md", "dist/retention.md");
