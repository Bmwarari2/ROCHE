import { describe, expect, it } from "vitest";
import { PASSWORD_MAX_LENGTH, passwordRuleBroken } from "./passwords";

describe("passwordRuleBroken (NCSC)", () => {
  it.each([
    ["correct horse battery staple", null],
    ["blue kettle seventy rivers", null],
    ["all lower case, no digits", null],
    ["short", "too_short"],
    ["elevenchars", "too_short"],
    ["x".repeat(PASSWORD_MAX_LENGTH + 1), "too_long"],
    ["Password1234", "common"],
    ["ADMINISTRATOR", "common"],
    ["aaaaaaaaaaaaaa", "repeated"],
    ["1234567890123", "sequence"],
    ["abcdefghijklmnop", "sequence"],
    ["harbour2026!!", "obvious_words"],
    ["qwerty letmein 99", "obvious_words"],
  ] as const)("%s", (password, expected) => {
    expect(passwordRuleBroken(password)).toBe(expected);
  });
});
