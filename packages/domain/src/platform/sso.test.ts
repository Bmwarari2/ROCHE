import { describe, expect, it } from "vitest";
import { type SsoSignIn, ssoSessionMayUse, ssoSignInDecision } from "./sso";

/**
 * Single sign-on policy (platform.md, Phase 2 rules 15 to 17; PLAT-005; ADR-0091 in slice 33).
 * Invented members on example.invalid domains.
 */

const signIn = (o: Partial<SsoSignIn> = {}): SsoSignIn => ({
  ssoEnabled: true,
  assertedEmail: "Ada.Example@care.example.invalid",
  emailVerifiedByProvider: true,
  verifiedDomains: ["care.example.invalid"],
  allowedRoleKeys: ["care_worker", "team_leader"],
  operator: false,
  member: {
    email: "ada.example@care.example.invalid",
    status: "active",
    kind: "staff",
    roleKeys: ["care_worker"],
  },
  ...o,
});

describe("PLAT-005 SSO sign-in policy", () => {
  it("signs in an active or invited member of a verified domain, matching the email exactly", () => {
    expect(ssoSignInDecision(signIn())).toEqual({ ok: true });
    expect(
      ssoSignInDecision(
        signIn({
          member: {
            email: "ada.example@care.example.invalid",
            status: "invited",
            kind: "staff",
            roleKeys: ["team_leader"],
          },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    ["SSO switched off for the organisation", { ssoEnabled: false }, "sso_off"],
    [
      "an email the provider has not verified",
      { emailVerifiedByProvider: false },
      "email_not_verified",
    ],
    [
      "a domain the organisation has not verified",
      { verifiedDomains: ["other.example.invalid"] },
      "domain_not_verified",
    ],
    [
      "a subdomain of a verified domain",
      { assertedEmail: "ada@mail.care.example.invalid" },
      "domain_not_verified",
    ],
    ["someone who is not a member: SSO never creates one", { member: null }, "not_a_member"],
    [
      "a member with a different email",
      { assertedEmail: "ada2@care.example.invalid" },
      "email_mismatch",
    ],
    [
      "a member who has left",
      {
        member: {
          email: "ada.example@care.example.invalid",
          status: "left",
          kind: "staff",
          roleKeys: ["care_worker"],
        },
      },
      "member_not_active",
    ],
    [
      "a family member",
      {
        member: {
          email: "ada.example@care.example.invalid",
          status: "active",
          kind: "family",
          roleKeys: [],
        },
      },
      "family_member",
    ],
    ["an operator", { operator: true }, "operator"],
    [
      "a member holding a role the organisation keeps off SSO",
      {
        member: {
          email: "ada.example@care.example.invalid",
          status: "active",
          kind: "staff",
          roleKeys: ["care_worker", "owner"],
        },
      },
      "role_not_allowed",
    ],
    ["a malformed email", { assertedEmail: "not an email" }, "email_not_verified"],
  ] as const)("refuses %s", (_name, change, problem) => {
    expect(ssoSignInDecision(signIn(change as Partial<SsoSignIn>))).toMatchObject({
      ok: false,
      problem,
    });
  });
});

describe("PLAT-005 an SSO session still needs Harbour's own second factor", () => {
  it.each([
    ["nothing sensitive", { careRecords: false, stepUp: false }, false, true],
    ["care records without Harbour's factor", { careRecords: true, stepUp: false }, false, false],
    ["care records with Harbour's factor", { careRecords: true, stepUp: false }, true, true],
    ["a step-up action without it", { careRecords: false, stepUp: true }, false, false],
    ["a step-up action with it", { careRecords: false, stepUp: true }, true, true],
  ])("for %s", (_name, needs, harbourFactorUsed, allowed) => {
    const result = ssoSessionMayUse({ viaSso: true, harbourFactorUsed }, needs);
    expect(result.ok).toBe(allowed);
    if (!result.ok) expect(result.problem).toBe("harbour_second_factor_required");
  });

  it("never counts the identity provider's own MFA claim", () => {
    expect(
      ssoSessionMayUse(
        { viaSso: true, harbourFactorUsed: false, providerMfaClaimed: true },
        { careRecords: true, stepUp: false },
      ),
    ).toMatchObject({ ok: false });
  });

  it("leaves sessions that did not come from SSO to the existing rules", () => {
    expect(
      ssoSessionMayUse(
        { viaSso: false, harbourFactorUsed: false },
        { careRecords: true, stepUp: true },
      ),
    ).toEqual({ ok: true });
  });
});
