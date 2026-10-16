import type { InvitationLookup } from "@harbour/contracts";
import type { PasswordRule } from "@harbour/domain";

/**
 * The invitation link (PLAT-004; platform.md, Invitations and MFA enrolment). The email links to
 * `/invitation#<token>`: a fragment never reaches a server in the URL, a log or a Referer. The page
 * reads it in the browser, keeps it in this tab's session storage (so it survives signing in
 * first), takes it out of the address bar, and sends it to the API only in a request body. Pure
 * helpers, unit tested.
 */

/** Session storage key for the token while the person signs in first. One tab only. */
export const INVITATION_TOKEN_KEY = "harbour.invitation";

/** How long a kept token lasts: long enough to sign in first, short on a shared computer. */
export const KEPT_TOKEN_MINUTES = 30;

/** The stored form of a kept token: the token and when it was kept. */
export function keptToken(token: string, now: Date): string {
  return JSON.stringify({ token, at: now.getTime() });
}

/** The kept token, or null when there is none, it is not one, or it is older than 30 minutes. */
export function readKeptToken(stored: string | null, now: Date): string | null {
  if (!stored) return null;
  try {
    const { token, at } = JSON.parse(stored) as { token?: unknown; at?: unknown };
    if (!isInvitationToken(token) || typeof at !== "number") return null;
    const age = now.getTime() - at;
    return age >= 0 && age <= KEPT_TOKEN_MINUTES * 60_000 ? token : null;
  } catch {
    return null;
  }
}

/** Forgets a kept token (signing out, accepting, or a link that can never work). */
export function forgetKeptToken(): void {
  try {
    window.sessionStorage.removeItem(INVITATION_TOKEN_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/**
 * Whether a request's Origin is this site (the invitation route handlers accept nothing else).
 * `host` is the host the person reached: X-Forwarded-Host behind the load balancer, else Host.
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(",")[0]?.trim();
  } catch {
    return false;
  }
}

/** The token's shape (`InvitationToken` in @harbour/contracts): 43 base64url characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The token in a URL fragment ("#abc…"), or null when there is none or it is not one. */
export function tokenFromFragment(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  return isInvitationToken(value) ? value : null;
}

export function isInvitationToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** Why the link cannot be used, as the page says it. Codes from the API's 409 refusals. */
export type InvitationRefusal =
  | NonNullable<InvitationLookup["refusal"]>
  | "invitation_closed"
  | "not_found"
  | "no_token";

const REFUSALS: ReadonlySet<string> = new Set<InvitationRefusal>([
  "invitation_expired",
  "invitation_used",
  "invitation_revoked",
  "organisation_not_active",
  "member_not_invited",
  "email_mismatch",
  "already_member",
  "invitation_closed",
  "not_found",
  "no_token",
]);

/** A refusal the page has words for; anything else reads as "already accepted or withdrawn". */
export function asRefusal(code: unknown): InvitationRefusal {
  return typeof code === "string" && REFUSALS.has(code)
    ? (code as InvitationRefusal)
    : "invitation_closed";
}

/** Refusals after which the link can never work, so the stored token is forgotten. */
export function isFinal(refusal: InvitationRefusal): boolean {
  return refusal !== "email_mismatch" && refusal !== "no_token";
}

/** Refusals whose next step is signing in (the link is spent or the person already belongs). */
export function offersSignIn(refusal: InvitationRefusal): boolean {
  return refusal === "invitation_used" || refusal === "already_member";
}

/** Whole minutes to wait from a 429's Retry-After (seconds), at least one. */
export function retryMinutes(retryAfter: string | null | undefined): number {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** What the lookup told the page, without the token. */
export type LookupResult =
  | {
      readonly kind: "found";
      readonly organisationName: string;
      readonly emailMasked: string | null;
      /** dd/mm/yyyy hh:mm, UK time. */
      readonly expiresAt: string;
      readonly path: InvitationLookup["path"];
    }
  | { readonly kind: "refused"; readonly refusal: InvitationRefusal }
  | { readonly kind: "throttled"; readonly minutes: number }
  | { readonly kind: "unavailable" };

export type AcceptResult =
  | {
      readonly kind: "accepted";
      /** `sign_in`: a sign-in was created, so the person signs in with it before enrolling. */
      readonly next: "sign_in" | "enrol";
      readonly destination: string;
    }
  | { readonly kind: "refused"; readonly refusal: InvitationRefusal }
  /** A sign-in exists for the address: sign in, then come back (`sign_in_first`). */
  | { readonly kind: "sign_in_first" }
  | {
      readonly kind: "invalid";
      readonly name?: "nameRequired";
      readonly password?: PasswordRule | "passwordRequired";
    }
  | { readonly kind: "throttled"; readonly minutes: number }
  | { readonly kind: "unavailable" };

/** Where MFA enrolment starts: the security page, which sets up a passkey or authenticator app. */
export const ENROLMENT_PATH = "/settings/security?reason=mfa";

/**
 * Where to go after accepting: enrolment. A new sign-in signs in first and lands there; an
 * existing one goes straight there (the page shows what is already set up).
 */
export function destinationAfterAccept(next: "sign_in" | "enrol"): string {
  if (next === "enrol") return ENROLMENT_PATH;
  return `/sign-in?${new URLSearchParams({ next: ENROLMENT_PATH }).toString()}`;
}

/** Sign in, then come back to this page, which picks the token up from session storage. */
export const SIGN_IN_THEN_RETURN = `/sign-in?${new URLSearchParams({ next: "/invitation" }).toString()}`;
