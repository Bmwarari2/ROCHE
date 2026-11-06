import { ELEARNING_PROTOCOL } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "./csp";
import {
  attemptChip,
  attemptOfToken,
  checkPackageUpload,
  contentCsp,
  contentOrigin,
  isContentHost,
  learnerNameOf,
  packagePathOf,
  readRuntimeMessage,
  runtimeCsp,
  runtimePage,
  siteOf,
} from "./elearning";
import { t } from "./i18n";

/** The e-learning web rules (workforce.md section 14; ADR-0093; slice 43). */

const ATTEMPT = "0199f300-0000-7000-8000-0000000000a1";
const token = (payload: unknown) =>
  `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"s".repeat(43)}`;

describe("WORK-006 the content origin is another site, from configuration only", () => {
  it.each([
    ["app.example.invalid", "example.invalid"],
    ["a.b.harbour.co.uk", "harbour.co.uk"],
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "localhost"],
  ])("places %s on the site %s", (host, site) => {
    expect(siteOf(host)).toBe(site);
  });

  it.each([
    [{ NODE_ENV: "development" }, "http://127.0.0.1:3000"],
    [{ NODE_ENV: "production" }, null],
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "https://app.example.invalid",
        ELEARNING_ORIGIN: "https://content.harbour-learning.invalid/x",
      },
      "https://content.harbour-learning.invalid",
    ],
    // Review H1: a subdomain of the app's own domain is the same site, so it is refused.
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "https://app.example.invalid",
        ELEARNING_ORIGIN: "https://learn.example.invalid",
      },
      null,
    ],
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "https://app.harbour.co.uk",
        ELEARNING_ORIGIN: "https://learn.harbour.co.uk",
      },
      null,
    ],
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "https://app.harbour.co.uk",
        ELEARNING_ORIGIN: "https://content.harbour-learning.co.uk",
      },
      "https://content.harbour-learning.co.uk",
    ],
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "https://harbour.invalid",
        ELEARNING_ORIGIN: "https://learn.harbour.invalid",
      },
      null,
    ],
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "https://app.example.invalid",
        ELEARNING_ORIGIN: "https://app.example.invalid",
      },
      null,
    ],
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "https://app.example.invalid",
        ELEARNING_ORIGIN: "http://content.harbour-learning.invalid",
      },
      null,
    ],
    [{ NODE_ENV: "development", ELEARNING_ORIGIN: "http://localhost:3000" }, null],
    [
      {
        NODE_ENV: "production",
        PUBLIC_WEB_URL: "http://localhost:3000",
        ELEARNING_ORIGIN: "http://127.0.0.1:3000",
      },
      "http://127.0.0.1:3000",
    ],
  ])("%j gives %s", (env, origin) => {
    expect(contentOrigin(env)).toBe(origin);
  });

  it("recognises the content host exactly", () => {
    expect(isContentHost("127.0.0.1:3000", "http://127.0.0.1:3000")).toBe(true);
    expect(isContentHost("localhost:3000", "http://127.0.0.1:3000")).toBe(false);
    expect(isContentHost(null, "http://127.0.0.1:3000")).toBe(false);
  });
});

describe("WORK-006 a package is told a first name only (review M8)", () => {
  it.each([
    ["Ada Example", "Ada"],
    ["  Cat   Carer ", "Cat"],
    ["Mo", "Mo"],
  ])("%j gives %j", (name, first) => {
    expect(learnerNameOf(name)).toBe(first);
  });
});

describe("WORK-006 launch paths and tokens", () => {
  it("reads the attempt from a token's payload, and nothing from a malformed one", () => {
    expect(attemptOfToken(token([ATTEMPT, "t", "w", "c", 1]))).toBe(ATTEMPT);
    expect(attemptOfToken(token(["not-a-uuid"]))).toBeNull();
    expect(attemptOfToken("short.x")).toBeNull();
    expect(attemptOfToken("../../etc.passwd")).toBeNull();
  });

  it.each([
    [["index.html"], "index.html"],
    [["course", "app.js"], "course/app.js"],
    [[], null],
    [["..", "x.js"], null],
    [["a", ".", "b.js"], null],
    [["a\\b.js"], null],
    [["a", "", "b.js"], null],
  ])("%j is %s", (segments, path) => {
    expect(packagePathOf(segments)).toBe(path);
  });
});

describe("WORK-006 policies keep package content off the app", () => {
  it("lets only the app frame the runtime page, and only the runtime page frame content", () => {
    expect(runtimeCsp("https://app.example.invalid")).toContain(
      "frame-ancestors https://app.example.invalid",
    );
    expect(runtimeCsp("https://app.example.invalid")).toContain("script-src 'self'");
    expect(runtimeCsp("https://app.example.invalid")).not.toMatch(/script-src[^;]*unsafe/);
    expect(contentCsp("https://app.example.invalid")).toContain(
      "frame-ancestors 'self' https://app.example.invalid",
    );
    expect(contentCsp("https://app.example.invalid")).toContain("object-src 'none'");
  });

  it("frames the content origin only where asked (the course player)", () => {
    expect(contentSecurityPolicy("n", false)).toContain("frame-src 'none'");
    expect(contentSecurityPolicy("n", false, ["https://learn.example.invalid"])).toContain(
      "frame-src https://learn.example.invalid",
    );
  });

  it("escapes what the runtime page writes", () => {
    const page = runtimePage({
      appOrigin: 'https://app.example.invalid"><script>',
      attemptId: ATTEMPT,
      title: "<b>",
      base: "/learn/t",
    });
    expect(page).not.toContain('"><script>');
    expect(page).toContain("&lt;b&gt;");
  });
});

describe("WORK-006 the player accepts only its own runtime's messages", () => {
  const frame = {};
  const expected = { origin: "https://learn.example.invalid", frame, attemptId: ATTEMPT };
  const ready = { protocol: ELEARNING_PROTOCOL, type: "ready", attemptId: ATTEMPT };
  it.each([
    ["the runtime's ready", { origin: expected.origin, source: frame, data: ready }, true],
    [
      "another origin",
      { origin: "https://evil.example.invalid", source: frame, data: ready },
      false,
    ],
    ["another window", { origin: expected.origin, source: {}, data: ready }, false],
    [
      "another attempt",
      {
        origin: expected.origin,
        source: frame,
        data: { ...ready, attemptId: "0199f300-0000-7000-8000-0000000000a2" },
      },
      false,
    ],
    [
      "another protocol",
      { origin: expected.origin, source: frame, data: { ...ready, protocol: "x" } },
      false,
    ],
    [
      "extra fields",
      { origin: expected.origin, source: frame, data: { ...ready, extra: 1 } },
      false,
    ],
    [
      "a commit",
      {
        origin: expected.origin,
        source: frame,
        data: {
          protocol: ELEARNING_PROTOCOL,
          type: "commit",
          attemptId: ATTEMPT,
          cmi: { "cmi.core.lesson_status": "passed" },
          finished: true,
        },
      },
      true,
    ],
    [
      "a commit with a non-string value",
      {
        origin: expected.origin,
        source: frame,
        data: {
          protocol: ELEARNING_PROTOCOL,
          type: "commit",
          attemptId: ATTEMPT,
          cmi: { a: 1 },
          finished: true,
        },
      },
      false,
    ],
  ])("%s", (_name, event, accepted) => {
    expect(readRuntimeMessage(event, expected) !== null).toBe(accepted);
  });
});

describe("WORK-006 package uploads", () => {
  const ok = {
    origin: "http://localhost:3000",
    contentType: "application/zip",
    contentLength: "1000",
    title: "Fire safety",
    topic: "fire_safety",
    tier: null,
  };
  const check = (o: Partial<typeof ok> & { tier?: string | null }) =>
    checkPackageUpload(
      { ...ok, ...o },
      "http://localhost:3000",
      ["fire_safety", "oliver_mcgowan"],
      t,
    );
  it.each([
    [{}, true],
    [{ origin: "https://evil.example.invalid" }, false],
    [{ origin: null }, false],
    [{ contentType: "application/pdf" }, false],
    [{ contentLength: null }, false],
    [{ contentLength: String(101 * 1024 * 1024) }, false],
    [{ title: "x" }, false],
    [{ topic: "astrology" }, false],
    [{ topic: "oliver_mcgowan" }, false],
    [{ topic: "oliver_mcgowan", tier: "2" }, true],
  ])("%j", (change, accepted) => {
    expect(check(change as never).ok).toBe(accepted);
  });
});

describe("WORK-006 attempts are an icon and a word", () => {
  it.each([
    ["passed", "Passed", "circle-check"],
    ["in_progress", "In progress", "clock"],
    ["failed", "Not passed", "circle-alert"],
    [null, "Not started", "circle-minus"],
  ] as const)("%s", (status, label, icon) => {
    expect(attemptChip(status, t)).toMatchObject({ label, icon });
  });
});
