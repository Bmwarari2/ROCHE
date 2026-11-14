import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Hermes on iOS has no `Intl.PluralRules` and no `Intl.Locale`; Node has both, so these tests remove
 * them first to run the catalogues the way the phone does. Without the polyfills the first plural
 * message throws, which is how Today crashed on the iOS Simulator (14/11/2026).
 */
const native = {
  PluralRules: Intl.PluralRules,
  Locale: Intl.Locale,
};

function restore(name: keyof typeof native) {
  Object.defineProperty(Intl, name, { value: native[name], writable: true, configurable: true });
}

/** Every argument in the catalogues accepts a number: plural, number, select (falls to `other`). */
function valuesWith(count: number): Record<string, number> {
  return new Proxy({}, { has: () => true, get: () => count });
}

// The counts reach every Welsh plural form: zero, one, two, few (3), many (6) and other (7).
const COUNTS = [0, 1, 2, 3, 6, 7];

describe("Intl on Hermes", () => {
  beforeAll(() => {
    Reflect.deleteProperty(Intl, "PluralRules");
    Reflect.deleteProperty(Intl, "Locale");
  });

  afterAll(() => {
    restore("PluralRules");
    restore("Locale");
  });

  it("cannot format a plural message without the polyfills (the crash)", async () => {
    const { createTranslator } = await import("@harbour/i18n");
    const t = createTranslator("en-GB");
    expect(() => t("mobile.today.peopleCount", valuesWith(2))).toThrow(/PluralRules/);
  });

  it("formats every en-GB and Welsh message, in every plural form, once loaded", async () => {
    await import("./intl-polyfills");
    expect(typeof Intl.PluralRules).toBe("function");
    expect(typeof Intl.Locale).toBe("function");
    expect(new Intl.PluralRules("en-GB").select(1)).toBe("one");
    expect(new Intl.PluralRules("cy").select(2)).toBe("two");
    expect(new Intl.PluralRules("cy").select(6)).toBe("many");

    const { catalogues, createTranslator, LOCALES } = await import("@harbour/i18n");
    for (const locale of LOCALES) {
      const t = createTranslator(locale);
      const keys = Object.keys(catalogues[locale]) as Array<keyof (typeof catalogues)["en-GB"]>;
      for (const key of keys) {
        for (const count of COUNTS) {
          expect(() => t(key, valuesWith(count)), `${locale} ${key} (${count})`).not.toThrow();
        }
      }
    }
  });
});

describe("app entry", () => {
  const root = (file: string) => fileURLToPath(new URL(`../../${file}`, import.meta.url));

  it("is index.ts, which loads the polyfills before expo-router", () => {
    const manifest = JSON.parse(readFileSync(root("package.json"), "utf8")) as { main: string };
    expect(manifest.main).toBe("index.ts");
    const imports = readFileSync(root("index.ts"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
    expect(imports).toEqual([
      'import "./src/platform/intl-polyfills";',
      'import "expo-router/entry";',
    ]);
  });
});
