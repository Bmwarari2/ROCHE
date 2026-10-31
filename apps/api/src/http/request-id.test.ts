import { describe, expect, it } from "vitest";
import { requestIdOf } from "./request-id";

describe("requestIdOf (security review, 31 October 2026)", () => {
  it.each([
    ["a UUID", "0194d000-0000-7000-8000-000000000301"],
    ["an upper-case UUID", "0194D000-0000-7000-8000-00000000ABCD"],
    ["letters, digits and hyphens", "web-req-42"],
    ["one character", "a"],
    ["64 characters", "a".repeat(64)],
  ])("keeps %s", (_label, value) => {
    expect(requestIdOf(value)).toBe(value);
  });

  it.each([
    ["no header", undefined],
    ["a null header", null],
    ["an empty header", ""],
    ["65 characters", "a".repeat(65)],
    ["a name and an NHS number", "Ada Example 9990000000"],
    ["an email address", "ada@example.invalid"],
    ["markup", "<script>alert(1)</script>"],
    ["a line break", "abc\ndef"],
    ["a trailing line break", "abc\n"],
    ["underscores and dots", "req_1.2"],
    ["non-ASCII letters", "réq-1"],
  ])("refuses %s", (_label, value) => {
    expect(requestIdOf(value)).toBeNull();
  });
});
