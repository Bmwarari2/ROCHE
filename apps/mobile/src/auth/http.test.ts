import { describe, expect, it } from "vitest";
import { cookiePairsFromSetCookie, isRetryableStatus, parseRetryAfter } from "./http";

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-09T13:05:00Z");

  it.each([
    [null, null],
    ["", null],
    ["5", 5000],
    [" 0 ", 0],
    ["Fri, 09 Oct 2026 13:05:30 GMT", 30_000],
    ["Fri, 09 Oct 2026 13:00:00 GMT", 0],
    ["soon", null],
  ])("%s -> %s", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe("isRetryableStatus", () => {
  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [409, false],
    [422, false],
  ])("%i -> %s", (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });
});

describe("cookiePairsFromSetCookie", () => {
  it("keeps only name=value pairs and survives commas in Expires", () => {
    expect(
      cookiePairsFromSetCookie(
        "a=1; Path=/; Expires=Fri, 09 Oct 2026 13:15:00 GMT; HttpOnly, b=two; Secure",
      ),
    ).toEqual(["a=1", "b=two"]);
  });

  it("handles a missing header", () => {
    expect(cookiePairsFromSetCookie(null)).toEqual([]);
  });
});
