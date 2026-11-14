import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { m3Scheme } from "./m3-scheme";
import { computeScheme, SEED, schemeModule } from "./m3-scheme-source";

/**
 * The phone app's Material 3 scheme is generated, never edited (ADR-0138). Set UPDATE_M3_SCHEME=1
 * to write it: `UPDATE_M3_SCHEME=1 pnpm --filter @harbour/ui exec vitest run m3-scheme`, then
 * format it with Biome.
 */
// A path built from the string form: jsdom replaces the global URL class, which node:url refuses.
const file = join(dirname(fileURLToPath(import.meta.url)), "m3-scheme.ts");

describe("the Material 3 scheme", () => {
  it.runIf(process.env.UPDATE_M3_SCHEME === "1")("is written from the seed", () => {
    writeFileSync(file, schemeModule());
  });

  it("is the one the seed generates", () => {
    expect(m3Scheme).toEqual(computeScheme());
    expect(readFileSync(file, "utf8")).toContain(`from the seed ${SEED}`);
  });

  it("keeps the Thapsus teal as the light primary container", () => {
    expect(m3Scheme.light.primaryContainer).toBe(SEED.toLowerCase());
  });
});
