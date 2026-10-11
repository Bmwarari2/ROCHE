import { describe, expect, it } from "vitest";
import {
  computeCheckDigit,
  formatNhsNumber,
  isTestRangeNhsNumber,
  normaliseNhsNumber,
  validateNhsNumber,
} from "./nhs-number";

describe("validateNhsNumber (modulus 11)", () => {
  it.each([
    ["9990000018", { valid: true, value: "9990000018" }],
    ["999 000 0026", { valid: true, value: "9990000026" }],
    ["999-000-0034", { valid: true, value: "9990000034" }],
    ["9990000107", { valid: true, value: "9990000107" }],
    ["", { valid: false, problem: "empty" }],
    ["   ", { valid: false, problem: "empty" }],
    ["999000001", { valid: false, problem: "not_ten_digits" }],
    ["99900000181", { valid: false, problem: "not_ten_digits" }],
    ["99900000AB", { valid: false, problem: "not_ten_digits" }],
    ["9990000019", { valid: false, problem: "invalid_check_digit" }],
    // 999000000 produces a check value of 10, so no number starting with it is valid.
    ["9990000000", { valid: false, problem: "invalid_check_digit" }],
  ])("%s", (input, expected) => {
    expect(validateNhsNumber(input)).toEqual(expected);
  });
});

describe("computeCheckDigit", () => {
  it.each([
    ["999000001", 8],
    ["999000002", 6],
    ["999000010", 7],
    ["999000009", 3],
    ["999000000", null],
    ["12345678", null],
    ["abcdefghi", null],
  ])("%s -> %s", (firstNine, expected) => {
    expect(computeCheckDigit(firstNine)).toBe(expected);
  });

  it("maps a remainder of zero to a check digit of zero", () => {
    // Find a prefix whose weighted sum is a multiple of 11 and confirm the rule.
    let prefix = "";
    for (let n = 100000000; n < 100000200; n++) {
      const s = String(n);
      let sum = 0;
      for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
      if (sum % 11 === 0) {
        prefix = s;
        break;
      }
    }
    expect(prefix).not.toBe("");
    expect(computeCheckDigit(prefix)).toBe(0);
  });
});

describe("formatting and helpers", () => {
  it.each([
    ["9990000018", "999 000 0018"],
    ["999 000 0018", "999 000 0018"],
    ["12345", "12345"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatNhsNumber(input)).toBe(expected);
  });

  it("normalises spaces and hyphens", () => {
    expect(normaliseNhsNumber(" 999-000 0018 ")).toBe("9990000018");
  });

  it.each([
    ["9990000018", true],
    ["1234567890", false],
  ])("test range %s -> %s", (input, expected) => {
    expect(isTestRangeNhsNumber(input)).toBe(expected);
  });
});
