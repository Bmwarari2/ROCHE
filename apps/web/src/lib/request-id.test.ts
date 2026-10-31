import { describe, expect, it } from "vitest";
import { wellFormedRequestId } from "./request-id";

describe("wellFormedRequestId (security reviews, 31 October 2026 and of #134, M4)", () => {
  it.each([
    ["a UUID v7", "0194d000-0000-7000-8000-000000000301"],
    ["a UUID v4", "3f2b8c1e-9d4a-4f6b-8e2c-1a5b7c9d0e4f"],
  ])("forwards %s", (_label, value) => {
    expect(wellFormedRequestId(value)).toBe(value);
  });

  it.each([
    ["no header", null],
    ["an empty header", ""],
    ["an upper-case UUID", "0194D000-0000-7000-8000-00000000ABCD"],
    ["letters, digits and hyphens", "web-req-42"],
    ["a name and an NHS number in an id's shape", "Ada-Example-9434765919"],
    ["a name and an NHS number", "Ada Example 9990000000"],
    ["an email address", "ada@example.invalid"],
    ["markup", "<script>alert(1)</script>"],
    ["a trailing line break", "0194d000-0000-7000-8000-000000000301\n"],
  ])("drops %s", (_label, value) => {
    expect(wellFormedRequestId(value)).toBeNull();
  });
});
