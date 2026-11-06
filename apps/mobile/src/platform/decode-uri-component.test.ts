import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Link query strings are parsed by expo-router through query-string 7, which loads
 * decode-uri-component 0.2.2 with require(). That copy is patched
 * (patches/decode-uri-component@0.2.2.patch) with a CommonJS port of 0.5.1's linear-time decoder,
 * closing GHSA-qr28-fpjm-wq7f and GHSA-vcc3-ghjq-m6fr, where a crafted link froze the app
 * (docs/compliance/vulnerability-exceptions.md). These tests load the copies the app loads, by the
 * same dependency path, and prove the patch keeps 0.2.2's documented results and decodes a crafted
 * 200 KB link quickly.
 */

type Decode = (encodedURI: unknown) => string;
type QueryString = { parse: (query: string) => Record<string, unknown> };

const fromMobile = createRequire(import.meta.url);
const fromRouter = createRequire(fromMobile.resolve("expo-router/package.json"));
const fromQueryString = createRequire(fromRouter.resolve("query-string"));
const decode = fromQueryString("decode-uri-component") as Decode;
const queryString = fromRouter("query-string") as QueryString;

/** Milliseconds `run` takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("decode-uri-component as expo-router loads it", () => {
  it("is the 0.2.2 copy that query-string 7 requires", () => {
    expect(fromQueryString("decode-uri-component/package.json").version).toBe("0.2.2");
    expect(fromRouter("query-string/package.json").version).toMatch(/^7\./);
  });

  // The usage examples in decode-uri-component 0.2.2's README, with its results.
  it.each([
    ["%25", "%"],
    ["%", "%"],
    ["st%C3%A5le", "ståle"],
    ["%st%C3%A5le%", "%ståle%"],
    ["%%7Bst%C3%A5le%7D%", "%{ståle}%"],
    ["%7B%ab%%7C%de%%7D", "{%ab%|%de%}"],
    ["%FE%FF", "��"],
    ["%C2", "�"],
    ["%C2%B5", "µ"],
  ])("decodes %j to %j, as 0.2.2's README documents", (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  it("decodes + to a space, as 0.2.2 does", () => {
    expect(decode("Ada+Example")).toBe("Ada Example");
    expect(decode("a+%2B+b")).toBe("a + b");
  });

  it("refuses a value that is not a string with 0.2.2's error", () => {
    expect(() => decode(42)).toThrow(
      new TypeError("Expected `encodedURI` to be of type `string`, got `number`"),
    );
  });

  // Unpatched, 0.2.2 took more than a second on each of these at 900 bytes, and about 20 seconds
  // at 3 KB.
  it.each([
    ["continuation bytes", "%80"],
    ["truncated two-byte sequences", "%C2"],
    ["truncated three-byte sequences", "%E2%82%E2"],
    ["byte order marks among invalid bytes", "%FF%FE%80"],
  ])("decodes a crafted 200 KB run of %s in well under a second", (_name, unit) => {
    const input = unit.repeat(Math.ceil((200 * 1024) / unit.length));
    let output = "";
    const ms = timed(() => {
      output = decode(input);
    });
    expect(output.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
  });

  it("parses a link query with a crafted 200 KB value in well under a second", () => {
    const query = `task=${"%80".repeat(70_000)}&note=Ada+Example`;
    let parsed: Record<string, unknown> = {};
    const ms = timed(() => {
      parsed = queryString.parse(query);
    });
    expect(parsed.note).toBe("Ada Example");
    expect(String(parsed.task)).toHaveLength(210_000);
    expect(ms).toBeLessThan(1000);
  });
});
