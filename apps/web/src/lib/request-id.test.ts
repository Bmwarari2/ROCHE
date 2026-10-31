import { describe, expect, it } from "vitest";
import { wellFormedRequestId } from "./request-id";

describe("wellFormedRequestId (security review, 31 October 2026)", () => {
  it.each([
    ["a UUID", "0194d000-0000-7000-8000-000000000301"],
    ["letters, digits and hyphens", "web-req-42"],
    ["64 characters", "a".repeat(64)],
  ])("forwards %s", (_label, value) => {
    expect(wellFormedRequestId(value)).toBe(value);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["65 characters", "a".repeat(65)],
    ["a name and an NHS number", "Ada Example 9990000000"],
    ["an email address", "ada@example.invalid"],
    ["markup", "<script>alert(1)</script>"],
    ["a trailing line break", "abc\n"],
  ])("drops %s", (_label, value) => {
    expect(wellFormedRequestId(value)).toBeNull();
  });
});
