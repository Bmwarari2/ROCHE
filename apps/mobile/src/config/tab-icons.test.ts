import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ADR-0138: every Care mode tab has its Lucide icon as a template PNG at 1x, 2x and 3x
 * (`scripts/tab-icons.mjs`), and the tab layout uses those images, never SF Symbols.
 */
const TABS = ["today", "round", "medicines", "people", "more"];
const at = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const PNG = [0x89, 0x50, 0x4e, 0x47];

describe("tab bar icons", () => {
  it.each(TABS)("%s has a PNG at every scale", (tab) => {
    for (const suffix of ["", "@2x", "@3x"]) {
      const file = at(`assets/tabs/${tab}${suffix}.png`);
      expect(existsSync(file), file).toBe(true);
      expect([...readFileSync(file).subarray(0, 4)]).toEqual(PNG);
    }
  });

  it("are the images the tab layout uses, with no SF Symbols", () => {
    const layout = readFileSync(at("src/app/(care)/_layout.tsx"), "utf8");
    for (const tab of TABS) expect(layout).toContain(`assets/tabs/${tab}.png`);
    expect(layout).not.toMatch(/\bsf=/);
  });
});
