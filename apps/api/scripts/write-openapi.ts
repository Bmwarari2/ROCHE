import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";

// Writes the OpenAPI 3.1 document to apps/api/openapi.json; CI diffs it against main (section 7).
const { app, close } = createApp(
  loadConfig({ ...process.env, APP_VERSION: "0.0.0" }),
  createLogger("silent"),
);
const response = await app.request("/openapi.json");
const target = fileURLToPath(new URL("../openapi.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(await response.json(), null, 2)}\n`);
await close();
console.log(`Wrote ${target}`);
