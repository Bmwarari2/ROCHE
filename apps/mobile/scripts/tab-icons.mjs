#!/usr/bin/env node
// Draws the Care mode tab bar icons from Lucide (ISC) as template PNGs at 1x, 2x and 3x
// (ADR-0138). Native tabs take image icons, so neither platform falls back to SF Symbols or
// Material Symbols. The images are black on transparent; each platform tints them (iOS template
// rendering, Android's tint list), so one set serves light, dark and the selected state.
//
// Run after changing TAB_ICONS: node apps/mobile/scripts/tab-icons.mjs
// It needs Playwright's Chromium (a development tool, not an app dependency). The PNGs are
// committed; src/config/tab-icons.test.ts checks every tab has all three.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Tab route name to Lucide icon name. */
export const TAB_ICONS = {
  today: "calendar-days",
  round: "list-checks",
  medicines: "pill",
  people: "users",
  more: "ellipsis",
};

/** Points: Material 3's 24 dp navigation icon, and close to iOS's 25 pt tab bar icon. */
const SIZE = 24;
/** A little heavier than the app's 1.5 so the small icon reads at a glance. */
const STROKE = 1.75;
const SCALES = [1, 2, 3];

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "assets", "tabs");

function iconNode(name) {
  // The package exports no package.json, so find it through the app's own node_modules link.
  const pkg = realpathSync(join(here, "..", "node_modules", "lucide-react-native"));
  const source = readFileSync(join(pkg, "dist", "esm", "icons", `${name}.mjs`), "utf8");
  const literal = /const __iconData = (\{[\s\S]*?\n\});/.exec(source)?.[1];
  if (!literal) throw new Error(`No icon data in ${name}.mjs`);
  // The icon's own data object: shapes and attributes only.
  return new Function(`return ${literal};`)().node;
}

function svg(node, pixels) {
  const shapes = node
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs)
        .filter(([key]) => key !== "key")
        .map(([key, value]) => `${key}="${value}"`)
        .join(" ");
      return `<${tag} ${pairs}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Playwright as installed for the web app's tests, or wherever this machine has it.
  const { chromium } = createRequire(join(here, "..", "..", "web", "package.json"))("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  mkdirSync(out, { recursive: true });
  for (const [tab, icon] of Object.entries(TAB_ICONS)) {
    const node = iconNode(icon);
    for (const scale of SCALES) {
      const pixels = SIZE * scale;
      await page.setViewportSize({ width: pixels, height: pixels });
      await page.setContent(
        `<html><body style="margin:0;background:transparent">${svg(node, pixels)}</body></html>`,
      );
      const png = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: pixels, height: pixels },
      });
      const file = join(out, scale === 1 ? `${tab}.png` : `${tab}@${scale}x.png`);
      writeFileSync(file, png);
      console.log(`wrote ${file}`);
    }
  }
  await browser.close();
}
