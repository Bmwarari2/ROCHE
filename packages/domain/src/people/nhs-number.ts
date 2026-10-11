/**
 * NHS number validation (modulus 11 check digit, NHS Data Dictionary). The NHS number is the
 * consistent identifier for health and social care (Health and Social Care (Safety and Quality)
 * Act 2015) but never the only one; validation happens before storage and on import.
 */

export type NhsNumberProblem = "empty" | "not_ten_digits" | "invalid_check_digit";

export type NhsNumberResult =
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false; readonly problem: NhsNumberProblem };

/** Accepts spaces and hyphens as people type them ("999 000 0018"). */
export function normaliseNhsNumber(input: string): string {
  return input.replace(/[\s-]/g, "");
}

export function computeCheckDigit(firstNine: string): number | null {
  if (!/^\d{9}$/.test(firstNine)) return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(firstNine[i]) * (10 - i);
  const check = 11 - (sum % 11);
  if (check === 11) return 0;
  if (check === 10) return null;
  return check;
}

export function validateNhsNumber(input: string): NhsNumberResult {
  const value = normaliseNhsNumber(input);
  if (value.length === 0) return { valid: false, problem: "empty" };
  if (!/^\d{10}$/.test(value)) return { valid: false, problem: "not_ten_digits" };
  const expected = computeCheckDigit(value.slice(0, 9));
  if (expected === null || expected !== Number(value[9])) {
    return { valid: false, problem: "invalid_check_digit" };
  }
  return { valid: true, value };
}

/** Display format used on screens and print: 3-3-4 digits separated by spaces. */
export function formatNhsNumber(value: string): string {
  const digits = normaliseNhsNumber(value);
  if (!/^\d{10}$/.test(digits)) return value;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

/** Numbers beginning 999 are reserved for testing; seed data and fixtures must use them. */
export function isTestRangeNhsNumber(value: string): boolean {
  return normaliseNhsNumber(value).startsWith("999");
}
