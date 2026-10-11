import { describe, expect, it } from "vitest";
import { passwordProblem } from "./password-policy";

describe("passwordProblem (NCSC)", () => {
  it.each([
    ["correct horse battery staple", null],
    ["blue kettle seventy rivers", null],
    ["short", "Use at least 12 characters."],
    ["Password1234", "That password is too common. Try three random words."],
    ["aaaaaaaaaaaaaa", "Avoid repeating one character."],
    ["1234567890123", "Avoid simple sequences."],
    ["harbour2026!!", "Avoid passwords built from obvious words. Try three random words."],
  ])("%s", (password, expected) => {
    expect(passwordProblem(password)).toBe(expected);
  });
});
