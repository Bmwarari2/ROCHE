import { describe, expect, it } from "vitest";
import { redirectForProblem, safeNextPath } from "./problems";

describe("redirectForProblem", () => {
  it.each([
    ["unauthenticated", undefined, "/sign-in"],
    ["unauthenticated", "/", "/sign-in"],
    ["unauthenticated", "/people", "/sign-in?next=%2Fpeople"],
    ["step_up_required", "/people/123", "/sign-in?reason=step-up&next=%2Fpeople%2F123"],
    ["step_up_required", undefined, "/sign-in?reason=step-up"],
    ["tenant_required", undefined, "/choose-organisation"],
    ["not_a_member", "/people", "/choose-organisation?next=%2Fpeople"],
    ["mfa_enrolment_required", "/people", "/settings/security?reason=mfa"],
    ["missing_permission", "/people", null],
    ["not_found", "/people/123", null],
    ["internal", undefined, null],
    [undefined, undefined, null],
  ] as const)("%s from %s goes to %s", (code, next, expected) => {
    expect(redirectForProblem(code, next)).toBe(expected);
  });

  it("never carries an off-site next address", () => {
    expect(redirectForProblem("unauthenticated", "https://example.invalid/")).toBe("/sign-in");
    expect(redirectForProblem("unauthenticated", "//example.invalid")).toBe("/sign-in");
  });
});

describe("safeNextPath", () => {
  it.each([
    ["/people/123", "/people/123"],
    ["/notifications?x=1", "/notifications?x=1"],
    ["/", "/"],
    ["https://example.invalid", null],
    ["//example.invalid", null],
    ["/\\example.invalid", null],
    ["/people\\..", null],
    ["/people\n", null],
    ["people", null],
    ["", null],
    [undefined, null],
    [["/people"], null],
    [`/${"a".repeat(600)}`, null],
  ])("%s gives %s", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });
});
