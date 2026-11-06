import { createRequire, Module } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * decode-uri-component 0.2.2 reaches the app through expo-router > query-string 7, which loads it
 * with require(). It is dormant on today's link path. expo-router 57 parses a link's query with
 * URLSearchParams in its own getStateFromPath (build/fork/getStateFromPath-forks.js), screens read
 * their parameters with useLocalSearchParams (the built-in decodeURIComponent in a try/catch), and
 * query-string is loaded only to build paths (stringify, which never decodes) and by React
 * Navigation's own getStateFromPath, which expo-router replaces with its fork.
 *
 * The copy is still patched (patches/decode-uri-component@0.2.2.patch) with a CommonJS port of
 * 0.5.1's linear-time decoder, which closes GHSA-qr28-fpjm-wq7f and GHSA-vcc3-ghjq-m6fr: defence
 * in depth, in case a later expo-router or another package calls it
 * (docs/compliance/vulnerability-exceptions.md). These tests load the copies the app loads, by the
 * same dependency path. They prove that the patch keeps 0.2.2's results for well-formed values, pin
 * where it differs (malformed escapes only), and decode crafted 200 KB inputs quickly; and that a
 * crafted 200 KB link through expo-router's own getStateFromPath is quick and never reaches this
 * decoder.
 */

type Decode = (encodedURI: unknown) => string;
type QueryString = { parse: (query: string) => Record<string, unknown> };
type Route = { name: string; params?: Record<string, unknown>; state?: State };
type State = { routes: Route[] };
type GetStateFromPath = (path: string, options: { screens: object }) => State | undefined;

const fromMobile = createRequire(import.meta.url);
const fromRouter = createRequire(fromMobile.resolve("expo-router/package.json"));
const fromQueryString = createRequire(fromRouter.resolve("query-string"));
const decode = fromQueryString("decode-uri-component") as Decode;
const queryString = fromRouter("query-string") as QueryString;

/**
 * expo-router's own getStateFromPath (build/fork/getStateFromPath.js), which it hands to React
 * Navigation for every link. The one module it loads that needs the native runtime is React
 * Navigation's `native` index, from which it takes validatePathConfig alone. That index is replaced
 * in Node's module cache, for the load only, by one holding expo-router's own validatePathConfig,
 * so the rest of the path runs unchanged.
 */
function loadGetStateFromPath(): GetStateFromPath {
  const nativeIndex = fromRouter.resolve("./build/react-navigation/native/index.js");
  const standIn = new Module(nativeIndex);
  standIn.filename = nativeIndex;
  standIn.loaded = true;
  standIn.exports = {
    validatePathConfig: fromRouter("./build/react-navigation/core/validatePathConfig.js")
      .validatePathConfig,
  };
  fromRouter.cache[nativeIndex] = standIn;
  try {
    return fromRouter("./build/fork/getStateFromPath.js").getStateFromPath as GetStateFromPath;
  } finally {
    delete fromRouter.cache[nativeIndex];
  }
}

/** The innermost route of a navigation state: the screen the link opens. */
function screenOf(state: State | undefined): Route | undefined {
  const route = state?.routes.at(-1);
  return route?.state ? screenOf(route.state) : route;
}

/** Milliseconds `run` takes. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/** `unit` repeated to at least 200 KB. */
function crafted(unit: string): string {
  return unit.repeat(Math.ceil((200 * 1024) / unit.length));
}

// Patched, the slowest crafted input (every sequence throws inside the built-in decoder) takes
// about 115 milliseconds per 200 KB in Node; unpatched, 0.2.2 took about 20 seconds at 3 KB. The
// bound leaves room for a slow CI runner.
const LIMIT_MS = 1000;

// Invalid UTF-8 whose structure looks valid, so the decoder tries each sequence with the built-in
// decoder, which throws: the slowest path through the patched decoder.
const SLOWEST: [string, string][] = [
  ["UTF-16 surrogate code points", "%ED%A0%80"],
  ["code points above U+10FFFF", "%F4%90%80%80"],
];

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

  // A well-formed value never reaches the replaced code: 0.2.2 and the patch both return the
  // built-in decoder's result after turning + into a space. Values shaped like the app's own route
  // parameters (people, tasks and corrections by UUID, chart kinds, dates and names).
  it.each([
    ["4f9c2a1e-7b3d-4c8a-9e21-0d5b6a7c8e9f", "4f9c2a1e-7b3d-4c8a-9e21-0d5b6a7c8e9f"],
    ["vital-signs", "vital-signs"],
    ["2026-11-06", "2026-11-06"],
    ["2026-11-06T09%3A30%3A00.000Z", "2026-11-06T09:30:00.000Z"],
    ["Si%C3%A2n%20Example", "Siân Example"],
    ["Zo%C3%AB+Example", "Zoë Example"],
    ["%E5%B1%B1%E7%94%B0+Example", "山田 Example"],
    ["O%27Example-Smith", "O'Example-Smith"],
    ["100%25", "100%"],
    ["a%2Bb", "a+b"],
  ])("decodes the route-shaped value %j to %j, as 0.2.2 does", (input, expected) => {
    expect(decode(input)).toBe(expected);
    expect(decode(input)).toBe(decodeURIComponent(input.replace(/\+/g, " ")));
  });

  // Results differ from 0.2.2 only when the built-in decoder throws, that is for a malformed
  // escape. 0.2.2 replaced each run of escapes across the whole string, so text one replacement
  // produced could be decoded again, and it replaced byte order mark pairs before the escapes
  // around them. The patch decodes in one pass, left to right. 0.2.2's results are in the comments.
  it.each([
    // 0.2.2: "AA%" (the %41 that %25 produced was decoded again).
    ["%2541%41%", "%41A%"],
    // 0.2.2: "%41��" (the %41 before the pair was left encoded).
    ["%41%FE%FF", "A��"],
    // 0.2.2: "%FF��" (the pair was taken from the end, not the start).
    ["%FF%FE%FF", "��%FF"],
  ])("decodes the malformed %j to %j, where 0.2.2 differed", (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  it.each([
    ["%25%25%41%FE", "%%A%FE"],
    ["%E2%82%AC%FF", "€%FF"],
    ["%C3%A5%FF%C3%A5", "å%FFå"],
  ])("decodes the malformed %j to %j, as 0.2.2 does", (input, expected) => {
    expect(decode(input)).toBe(expected);
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
    ...SLOWEST,
  ])("decodes a crafted 200 KB run of %s in well under a second", (_name, unit) => {
    const input = crafted(unit);
    let output = "";
    const ms = timed(() => {
      output = decode(input);
    });
    expect(output.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it("parses a link query with a crafted 200 KB value in well under a second", () => {
    const query = `task=${"%80".repeat(70_000)}&note=Ada+Example`;
    let parsed: Record<string, unknown> = {};
    const ms = timed(() => {
      parsed = queryString.parse(query);
    });
    expect(parsed.note).toBe("Ada Example");
    expect(String(parsed.task)).toHaveLength(210_000);
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});

describe("a link through expo-router's own getStateFromPath", () => {
  const getStateFromPath = loadGetStateFromPath();
  // The shape of the app's note screen, src/app/(care)/people/[personId]/note.tsx.
  const linking = {
    screens: {
      "(care)": { path: "", screens: { "people/[personId]/note": "people/:personId/note" } },
    },
  };
  const personId = "4f9c2a1e-7b3d-4c8a-9e21-0d5b6a7c8e9f";

  it("opens the screen with its parameters decoded", () => {
    const screen = screenOf(
      getStateFromPath(`/people/${personId}/note?correct=Zo%C3%AB+Example`, linking),
    );
    expect(screen?.name).toBe("people/[personId]/note");
    expect(screen?.params).toMatchObject({ personId, correct: "Zoë Example" });
  });

  // URLSearchParams turns every byte of invalid UTF-8 into U+FFFD, where decode-uri-component
  // would leave the escapes as they came: the value shows which decoder ran.
  it.each(SLOWEST)(
    "parses a crafted 200 KB link of %s quickly, without decode-uri-component",
    (_name, unit) => {
      const value = crafted(unit);
      let state: State | undefined;
      const ms = timed(() => {
        state = getStateFromPath(`/people/${personId}/note?correct=${value}`, linking);
      });
      const screen = screenOf(state);
      expect(screen?.params?.personId).toBe(personId);
      expect(screen?.params?.correct).toBe("�".repeat(value.length / 3));
      expect(ms).toBeLessThan(LIMIT_MS);
    },
  );
});
