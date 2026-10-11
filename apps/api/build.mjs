import { build } from "esbuild";

// Bundles the API and worker (workspace packages included) into single ESM files for the container.
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
