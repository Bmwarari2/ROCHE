import { isPlausibleEmail, normaliseEmail } from "../shared/email";
import type { MemberStatus } from "./invitations";

/**
 * Single sign-on policy (PLAT-005; platform.md, Phase 2 rules 15 to 17; ADR-0091 in slice 33). SSO
 * only signs in someone who is already an invited or active member of the organisation, by an email
 * the identity provider verified on a domain the organisation verified, and only when every role
 * they hold is one the organisation lets use SSO. It never creates a member, links another email,
 * or signs in a family member or an operator. It is a first factor only: care records and step-up
 * still need Harbour's own second factor, and a provider's own MFA claim never counts (section 5.3).
 */

export interface SsoSignIn {
  readonly ssoEnabled: boolean;
  /** The email the identity provider asserts. */
  readonly assertedEmail: string;
  readonly emailVerifiedByProvider: boolean;
  /** The organisation's verified email domains (lower case, exact match). */
  readonly verifiedDomains: readonly string[];
  /** The role keys the organisation lets sign in with SSO. */
  readonly allowedRoleKeys: readonly string[];
  /** The signing-in identity is a Thapsus operator. */
  readonly operator: boolean;
  /** The member with this email in the organisation, if any. */
  readonly member: {
    readonly email: string;
    readonly status: MemberStatus;
    readonly kind: "staff" | "family";
    readonly roleKeys: readonly string[];
  } | null;
}

export type SsoProblem =
  | "sso_off"
  | "email_not_verified"
  | "domain_not_verified"
  | "not_a_member"
  | "email_mismatch"
  | "member_not_active"
  | "family_member"
  | "operator"
  | "role_not_allowed";

const SSO_MESSAGES: Record<SsoProblem, string> = {
  sso_off: "Single sign-on is not switched on for this organisation.",
  email_not_verified: "Your organisation's sign-in did not confirm your email address.",
  domain_not_verified: "This organisation has not verified your email domain for single sign-on.",
  not_a_member: "Ask your manager to invite you to Harbour first.",
  email_mismatch: "Sign in with the email address you were invited with.",
  member_not_active: "Your account is not active in this organisation.",
  family_member: "Family members sign in with their own Harbour sign-in, not single sign-on.",
  operator: "Thapsus operators sign in to the operator console, not with single sign-on.",
  role_not_allowed: "Your role signs in with Harbour's own sign-in, not single sign-on.",
};

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Whether an SSO assertion may sign this person in (rules 15 and 16). */
export function ssoSignInDecision(
  input: SsoSignIn,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: SsoProblem; readonly message: string } {
  const refuse = (problem: SsoProblem) =>
    ({ ok: false, problem, message: SSO_MESSAGES[problem] }) as const;
  if (!input.ssoEnabled) return refuse("sso_off");
  if (input.operator) return refuse("operator");
  if (!input.emailVerifiedByProvider || !isPlausibleEmail(input.assertedEmail)) {
    return refuse("email_not_verified");
  }
  const email = normaliseEmail(input.assertedEmail);
  const domains = new Set(input.verifiedDomains.map(normaliseEmail));
  if (!domains.has(domainOf(email))) return refuse("domain_not_verified");
  const member = input.member;
  if (!member) return refuse("not_a_member");
  if (normaliseEmail(member.email) !== email) return refuse("email_mismatch");
  if (member.kind === "family") return refuse("family_member");
  if (member.status !== "active" && member.status !== "invited") return refuse("member_not_active");
  const allowed = new Set(input.allowedRoleKeys);
  if (member.roleKeys.some((role) => !allowed.has(role))) return refuse("role_not_allowed");
  return { ok: true };
}

export interface SsoSessionFactors {
  readonly viaSso: boolean;
  /** A Harbour passkey or authenticator code used on this session. */
  readonly harbourFactorUsed: boolean;
  /** The identity provider says it used MFA: recorded, never counted (rule 17). */
  readonly providerMfaClaimed?: boolean;
}

/** Whether an SSO session may use something that needs care records or step-up (rule 17). */
export function ssoSessionMayUse(
  session: SsoSessionFactors,
  needs: { readonly careRecords: boolean; readonly stepUp: boolean },
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: "harbour_second_factor_required";
      readonly message: string;
    } {
  if (!session.viaSso) return { ok: true };
  if ((needs.careRecords || needs.stepUp) && !session.harbourFactorUsed) {
    return {
      ok: false,
      problem: "harbour_second_factor_required",
      message: "Confirm it is you with your Harbour passkey or authenticator code first.",
    };
  }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// The connection and domains (platform.md, Phase 2: single sign-on, rules 18 and 19; slice 33)
// ------------------------------------------------------------------------------------------------

export interface SsoConnectionInput {
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  /** The private key's name in the managed secret store, never the key. */
  readonly privateKeyRef: string;
  readonly tokenEndpointAuthentication:
    | "private_key_jwt"
    | "client_secret_basic"
    | "client_secret_post";
  readonly allowedRoleKeys: readonly string[];
}

export type SsoConnectionProblem =
  | "issuer_not_https"
  | "discovery_not_https"
  | "client_id_required"
  | "key_ref_invalid"
  | "client_secret_not_allowed"
  | "roles_required"
  | "unknown_role";

/** A name in the managed store: path segments of lower-case letters, digits and hyphens. */
export const SSO_KEY_REF =
  /^harbour\/sso\/[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62}){0,2}$/;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks a connection before it is saved (rule 18): https issuer and discovery URL, a client id,
 * the key referred to by its store name only, `private_key_jwt` only, and known roles.
 */
export function checkSsoConnection(
  input: SsoConnectionInput,
  knownRoleKeys: readonly string[],
): { readonly ok: true } | { readonly ok: false; readonly problem: SsoConnectionProblem } {
  const refuse = (problem: SsoConnectionProblem) => ({ ok: false, problem }) as const;
  if (!isHttpsUrl(input.issuer)) return refuse("issuer_not_https");
  if (!isHttpsUrl(input.discoveryUrl)) return refuse("discovery_not_https");
  if (input.clientId.trim().length === 0) return refuse("client_id_required");
  if (input.tokenEndpointAuthentication !== "private_key_jwt")
    return refuse("client_secret_not_allowed");
  if (!SSO_KEY_REF.test(input.privateKeyRef)) return refuse("key_ref_invalid");
  if (input.allowedRoleKeys.length === 0) return refuse("roles_required");
  if (input.allowedRoleKeys.some((r) => !knownRoleKeys.includes(r))) return refuse("unknown_role");
  return { ok: true };
}

/**
 * Domains anyone can get an address on: verifying one would let any of its users reach the SSO
 * check. Not exhaustive; the DNS proof is the control, this only stops an obvious mistake.
 */
export const PUBLIC_EMAIL_DOMAINS: readonly string[] = [
  "aol.com",
  "btinternet.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.co.uk",
  "live.com",
  "me.com",
  "msn.com",
  "nhs.net",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "sky.com",
  "talktalk.net",
  "virginmedia.com",
  "yahoo.co.uk",
  "yahoo.com",
];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A domain an organisation may claim (rule 19), normalised to lower case. */
export function checkSsoDomain(
  value: string,
):
  | { readonly ok: true; readonly domain: string }
  | { readonly ok: false; readonly problem: "malformed_domain" | "public_email_domain" } {
  const domain = value.trim().toLowerCase();
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)))
    return { ok: false, problem: "malformed_domain" };
  if (PUBLIC_EMAIL_DOMAINS.includes(domain)) return { ok: false, problem: "public_email_domain" };
  return { ok: true, domain };
}

/** The DNS TXT record that proves a domain (rule 19). */
export function ssoDomainRecord(domain: string, token: string) {
  return { name: `_harbour-verification.${domain}`, value: `harbour-verification=${token}` };
}

/** Whether the TXT records found carry the token, exactly. */
export function ssoDomainProved(records: readonly string[], token: string): boolean {
  const wanted = `harbour-verification=${token}`;
  return records.some((r) => r.trim() === wanted);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The provider id Better Auth knows an organisation's connection by. */
export function ssoProviderId(tenantId: string): string {
  return `harbour-${tenantId}`;
}

/** The organisation a provider id belongs to, or null for anything Harbour did not make. */
export function tenantOfSsoProvider(providerId: string): string | null {
  const id = providerId.startsWith("harbour-") ? providerId.slice("harbour-".length) : "";
  return UUID.test(id) ? id : null;
}
