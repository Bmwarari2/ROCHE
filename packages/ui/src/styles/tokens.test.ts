import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Container, type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import {
  breakpoints,
  button,
  colorDark,
  colorLight,
  elevation,
  fontFamily,
  layout,
  motion,
  navBlur,
  radius,
  space,
  statusFill,
  typeScale,
  typeScaleResponsive,
} from "../tokens/tokens";

/**
 * tokens.css must say exactly what tokens.ts says. These tests parse the stylesheet and compare
 * every value, so the two cannot drift.
 */

// Read from disk: Vitest does not process CSS imports, so a ?raw import would be empty.
const tokensCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tokens.css"), "utf8");
const root = postcss.parse(tokensCss);

function normalise(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function kebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/\./g, "-")
    .toLowerCase();
}

function declarations(container: Container): Map<string, string> {
  const map = new Map<string, string>();
  container.each((node) => {
    if (node.type === "decl") map.set(node.prop, normalise(node.value));
  });
  return map;
}

function findRule(container: Container, selectors: string[]): Rule {
  let found: Rule | undefined;
  container.each((node) => {
    if (
      node.type === "rule" &&
      normalise(node.selectors.join(",")) === normalise(selectors.join(","))
    ) {
      found = node;
    }
  });
  if (!found) throw new Error(`No rule for ${selectors.join(", ")}`);
  return found;
}

function findAtRule(name: string, params: string): AtRule {
  let found: AtRule | undefined;
  root.each((node) => {
    if (
      node.type === "atrule" &&
      node.name === name &&
      normalise(node.params) === normalise(params)
    ) {
      found = node;
    }
  });
  if (!found) throw new Error(`No @${name} ${params}`);
  return found;
}

/** The CSS name of a colour token: nav and navFallback are --nav-bg and --nav-bg-fallback. */
function colourProperty(key: string): string {
  if (key === "nav") return "--nav-bg";
  if (key === "navFallback") return "--nav-bg-fallback";
  return `--${kebab(key)}`;
}

function expectColours(block: Map<string, string>, scheme: Record<string, string>) {
  for (const [key, value] of Object.entries(scheme)) {
    expect(block.get(colourProperty(key)), `${colourProperty(key)} (${key})`).toBe(
      normalise(value),
    );
  }
}

const lightBlock = declarations(findRule(root, [":root", '[data-theme="light"]']));
const darkMediaBlock = declarations(
  findRule(findAtRule("media", "(prefers-color-scheme: dark)"), [
    ':root:not([data-theme="light"])',
  ]),
);
const darkAttributeBlock = declarations(findRule(root, ['[data-theme="dark"]']));
const rootBlock = declarations(findRule(root, [":root"]));

/** Type sizes are written in rem (16 px each), so text follows the browser's text size (WCAG 1.4.4). */
const rem = (px: number) => `${px / 16}rem`;

describe("tokens.css colours", () => {
  it("light colours match colorLight", () => {
    expectColours(lightBlock, colorLight);
  });

  it("dark colours under prefers-color-scheme match colorDark", () => {
    expectColours(darkMediaBlock, colorDark);
  });

  it('dark colours under [data-theme="dark"] match colorDark', () => {
    expectColours(darkAttributeBlock, colorDark);
  });

  it("defines no colour that the TypeScript tokens do not have", () => {
    const known = new Set([
      ...Object.keys(colorLight).map(colourProperty),
      "--nav-surface",
      "color-scheme",
    ]);
    for (const block of [lightBlock, darkMediaBlock, darkAttributeBlock]) {
      for (const property of block.keys()) {
        expect(known.has(property), property).toBe(true);
      }
    }
  });

  it("status fills are fixed across themes and match statusFill", () => {
    const expected: Record<string, string> = {
      "--status-overdue": statusFill.overdue,
      "--status-due": statusFill.due,
      "--status-done": statusFill.done,
      "--status-not-applicable": statusFill.notApplicable,
      "--status-info": statusFill.info,
      "--status-on-fill": statusFill.onFill,
    };
    for (const [property, value] of Object.entries(expected)) {
      expect(rootBlock.get(property), property).toBe(normalise(value));
      expect(darkMediaBlock.has(property)).toBe(false);
      expect(darkAttributeBlock.has(property)).toBe(false);
    }
  });

  it("falls back to an opaque navigation surface without backdrop-filter", () => {
    const supports = findAtRule(
      "supports",
      "not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))",
    );
    const block = declarations(
      findRule(supports, [':root:not([data-theme="light"])', "[data-theme]"]),
    );
    expect(block.get("--nav-surface")).toBe("var(--nav-bg-fallback)");
    expect(colorLight.navFallback).toContain("0.92");
    expect(colorDark.navFallback).toContain("0.92");
  });
});

describe("tokens.css type, layout and other groups", () => {
  it("uses the web font stack", () => {
    expect(rootBlock.get("--font-stack")).toBe(normalise(fontFamily.webSans));
    // The web stack keeps every family of the specified stack, in order.
    const families = fontFamily.sans.split(",").map((family) => family.trim());
    let lastIndex = -1;
    for (const family of families) {
      const index = fontFamily.webSans.indexOf(family);
      expect(index, family).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("type scale matches typeScale", () => {
    for (const [name, style] of Object.entries(typeScale)) {
      const prefix = `--type-${kebab(name)}`;
      expect(rootBlock.get(`${prefix}-size`), name).toBe(rem(style.size));
      expect(rootBlock.get(`${prefix}-line-height`), name).toBe(String(style.lineHeight));
      expect(rootBlock.get(`${prefix}-weight`), name).toBe(String(style.weight));
      expect(rootBlock.get(`${prefix}-tracking`), name).toBe(`${style.letterSpacingEm}em`);
    }
  });

  it("responsive sizes apply at the medium and small breakpoints", () => {
    const medium = declarations(
      findRule(findAtRule("media", `(max-width: ${breakpoints.medium}px)`), [":root"]),
    );
    const small = declarations(
      findRule(findAtRule("media", `(max-width: ${breakpoints.small}px)`), [":root"]),
    );
    for (const [size, block] of [
      ["medium", medium],
      ["small", small],
    ] as const) {
      for (const [name, style] of Object.entries(typeScaleResponsive[size])) {
        expect(block.get(`--type-${name}-size`), `${size} ${name}`).toBe(rem(style.size));
        expect(block.get(`--type-${name}-line-height`), `${size} ${name}`).toBe(
          String(style.lineHeight),
        );
      }
    }
    expect(rootBlock.get("--content-width")).toBe(`${layout.contentWidth}px`);
    expect(medium.get("--content-width")).toBe(`${layout.contentWidthMedium}px`);
    expect(small.get("--content-width")).toBe(`${layout.contentWidthSmallPercent}%`);
  });

  it("layout, spacing, radii, navigation, buttons, elevation and motion match", () => {
    const expected: Record<string, string> = {
      "--gutter": `${layout.gutter}px`,
      "--section-padding-min": `${layout.sectionPaddingMin}px`,
      "--section-padding-max": `${layout.sectionPaddingMax}px`,
      "--shell-page-padding": `${layout.shellPagePadding}px`,
      "--nav-height": `${layout.navHeight}px`,
      "--nav-height-touch": `${layout.navHeightTouchMax}px`,
      "--touch-target": `${layout.touchTarget}px`,
      "--corner-pill": `${radius.pill}px`,
      "--corner-card": `${radius.card}px`,
      "--corner-tile": `${radius.tile}px`,
      "--corner-input": `${radius.input}px`,
      "--corner-chip": `${radius.chip}px`,
      "--nav-backdrop": navBlur.backdropFilter,
      "--nav-text-size": rem(navBlur.textSizeDesktop),
      "--nav-text-size-drawer": rem(navBlur.textSizeDrawer),
      "--button-padding-y": `${button.paddingY}px`,
      "--button-padding-x": `${button.paddingX}px`,
      "--button-font-size": rem(button.fontSize),
      "--button-min-height": `${button.minHeight}px`,
      "--hairline": `${elevation.hairline}px`,
      "--elevation-floating": elevation.floating.css,
      "--motion-duration-fast": `${motion.durationFast}ms`,
      "--motion-duration": `${motion.durationBase}ms`,
      "--motion-duration-slow": `${motion.durationSlow}ms`,
      "--motion-easing": motion.easing,
      "--motion-reveal-translate": `${motion.revealTranslate}px`,
    };
    for (const [key, value] of Object.entries(space)) {
      if (value > 0) expected[`--space-${kebab(key)}`] = `${value}px`;
    }
    for (const [property, value] of Object.entries(expected)) {
      expect(rootBlock.get(property), property).toBe(normalise(value));
    }
  });

  it("disables motion under prefers-reduced-motion", () => {
    const reduced = declarations(
      findRule(findAtRule("media", "(prefers-reduced-motion: reduce)"), [":root"]),
    );
    expect(reduced.get("--motion-duration-fast")).toBe("0ms");
    expect(reduced.get("--motion-duration")).toBe("0ms");
    expect(reduced.get("--motion-duration-slow")).toBe("0ms");
    expect(reduced.get("--motion-reveal-translate")).toBe("0px");
  });
});
