import { describe, expect, it } from "vitest";
import {
  checkSsoConnection,
  checkSsoDomain,
  type SsoSignIn,
  ssoDomainProved,
  ssoDomainRecord,
  ssoProviderId,
  ssoSessionMayUse,
  ssoSignInDecision,
  tenantOfSsoProvider,
} from "./sso";

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

describe("PLAT-005 SSO connection checks (rule 18)", () => {
  const ok = {
    issuer: "https://login.example.invalid/tenant",
    discoveryUrl: "https://login.example.invalid/tenant/.well-known/openid-configuration",
    clientId: "harbour-client",
    privateKeyRef: "harbour/sso/acme-care",
    tokenEndpointAuthentication: "private_key_jwt" as const,
    allowedRoleKeys: ["care_worker"],
  };
  const known = ["care_worker", "registered_manager"];
  it.each([
    ["a valid connection", {}, null],
    ["an http issuer", { issuer: "http://login.example.invalid" }, "issuer_not_https"],
    ["a malformed issuer", { issuer: "not a url" }, "issuer_not_https"],
    [
      "an http discovery URL",
      { discoveryUrl: "http://login.example.invalid/x" },
      "discovery_not_https",
    ],
    ["a blank client id", { clientId: "  " }, "client_id_required"],
    [
      "a key name that is not a store name",
      { privateKeyRef: "-----BEGIN PRIVATE KEY-----" },
      "key_ref_invalid",
    ],
    [
      "a client secret",
      { tokenEndpointAuthentication: "client_secret_basic" },
      "client_secret_not_allowed",
    ],
    ["an unknown role", { allowedRoleKeys: ["nobody"] }, "unknown_role"],
    ["no roles", { allowedRoleKeys: [] }, "roles_required"],
  ] as const)("%s", (_name, change, problem) => {
    const result = checkSsoConnection({ ...ok, ...change }, known);
    if (problem === null) expect(result).toEqual({ ok: true });
    else expect(result).toMatchObject({ ok: false, problem });
  });
});

describe("PLAT-005 domain checks (rule 19)", () => {
  it.each([
    ["care.example.invalid", null],
    ["Care.Example.Invalid", null],
    ["gmail.com", "public_email_domain"],
    ["outlook.com", "public_email_domain"],
    ["nodot", "malformed_domain"],
    ["-bad.example.invalid", "malformed_domain"],
    ["has space.example.invalid", "malformed_domain"],
    ["a@b.example.invalid", "malformed_domain"],
  ] as const)("%s", (domain, problem) => {
    const result = checkSsoDomain(domain);
    if (problem === null) expect(result).toEqual({ ok: true, domain: domain.toLowerCase() });
    else expect(result).toMatchObject({ ok: false, problem });
  });
});

describe("PLAT-005 DNS proof (rule 19)", () => {
  it("names the record and value to publish", () => {
    expect(ssoDomainRecord("care.example.invalid", "abc123")).toEqual({
      name: "_harbour-verification.care.example.invalid",
      value: "harbour-verification=abc123",
    });
  });
  it.each([
    [["harbour-verification=abc123"], true],
    [["v=spf1 -all", "harbour-verification=abc123"], true],
    [[" harbour-verification=abc123 "], true],
    [["harbour-verification=abc124"], false],
    [["harbour-verification=ABC123"], false],
    [[], false],
  ] as const)("records %j prove it: %s", (records, proved) => {
    expect(ssoDomainProved(records, "abc123")).toBe(proved);
  });
});

describe("the provider id names its organisation", () => {
  const tenant = "0194d000-0000-7000-8000-000000000001";
  it("round trips, and refuses anything else", () => {
    expect(ssoProviderId(tenant)).toBe(`harbour-${tenant}`);
    expect(tenantOfSsoProvider(ssoProviderId(tenant))).toBe(tenant);
    expect(tenantOfSsoProvider("harbour-not-a-uuid")).toBeNull();
    expect(tenantOfSsoProvider("google")).toBeNull();
  });
});
