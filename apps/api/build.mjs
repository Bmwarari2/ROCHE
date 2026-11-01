import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
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
await build({ ...shared, entryPoints: ["src/jobs/dmd-job.ts"], outfile: "dist/dmd-job.js" });

// The migrator reads the SQL migrations and the reference documents at run time.
mkdirSync("dist/drizzle", { recursive: true });
cpSync("../../packages/db/drizzle", "dist/drizzle", { recursive: true });
copyFileSync("../../docs/specs/rates.md", "dist/rates.md");
copyFileSync("../../docs/specs/calendar.md", "dist/calendar.md");
copyFileSync("../../docs/specs/retention.md", "dist/retention.md");

// The printed packs embed Noto Sans (OFL); services/pdf-font.ts reads it from dist/fonts.
const require = createRequire(import.meta.url);
mkdirSync("dist/fonts", { recursive: true });
for (const font of ["400Regular/NotoSans_400Regular.ttf", "700Bold/NotoSans_700Bold.ttf"]) {
  const source = require.resolve(`@expo-google-fonts/noto-sans/${font}`);
  copyFileSync(source, `dist/fonts/${font.split("/")[1]}`);
}
const licence = require.resolve("@expo-google-fonts/noto-sans/LICENSE_FONT");
copyFileSync(licence, "dist/fonts/OFL.txt");
