import { describe, expect, it } from "vitest";
import { readSignInCode } from "./sign-in-code";

describe("the code typed at the second sign-in step", () => {
  it.each([
    ["123456", { kind: "totp", code: "123456" }],
    ["123 456", { kind: "totp", code: "123456" }],
    ["AbCd3-Ef9h2", { kind: "backup", code: "AbCd3-Ef9h2" }],
    ["abcd3ef9h2", { kind: "backup", code: "abcd3ef9h2" }],
    ["12345", null],
    ["1234567", null],
    ["abc", null],
    ["abcd-ef", null],
    ["", null],
  ] as const)("reads %s as %j", (typed, read) => {
    expect(readSignInCode(typed)).toEqual(read);
  });
});
