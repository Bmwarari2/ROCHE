import { describe, expect, it } from "vitest";
import { callerRequestIdOf } from "./request-id";

describe("callerRequestIdOf (security reviews, 31 October 2026 and of #134, M4)", () => {
  it.each([
    ["a UUID v7", "0194d000-0000-7000-8000-000000000301"],
    ["a UUID v4", "3f2b8c1e-9d4a-4f6b-8e2c-1a5b7c9d0e4f"],
  ])("keeps %s for the log", (_label, value) => {
    expect(callerRequestIdOf(value)).toBe(value);
  });

  it.each([
    ["no header", undefined],
    ["a null header", null],
    ["an empty header", ""],
    ["an upper-case UUID (not canonical)", "0194D000-0000-7000-8000-00000000ABCD"],
    ["a UUID with braces", "{0194d000-0000-7000-8000-000000000301}"],
    ["a UUID without hyphens", "0194d00000007000800000000000301a"],
    ["letters, digits and hyphens", "web-req-42"],
    ["a name and an NHS number in an id's shape", "Ada-Example-9434765919"],
    ["a name and an NHS number", "Ada Example 9990000000"],
    ["an email address", "ada@example.invalid"],
    ["markup", "<script>alert(1)</script>"],
    ["a UUID with a trailing line break", "0194d000-0000-7000-8000-000000000301\n"],
  ])("refuses %s", (_label, value) => {
    expect(callerRequestIdOf(value)).toBeNull();
  });
});
