/**
 * The public evidence pack page (`/evidence#<token>`; quality.md section 16; QUAL-003; HZ-050;
 * ADR-0050): what the page's three calls mean for an inspector. Pure and unit tested. The token
 * stays in the fragment, which no server sees; the page sends it only in JSON bodies to its own
 * route handlers, which pass it on to the API's `/p/evidence/code` and `/verify` in a body. Opening
 * the pack needs only the session cookie the API sets for that link.
 */

/** The link token's shape (the API's `linkToken`): 43 base64url characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isEvidenceToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** The token in a URL fragment ("#abc…"), or null when there is none or it is not one. */
export function evidenceTokenFromFragment(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  return isEvidenceToken(value) ? value : null;
}

/** Six digits, spaces ignored (people copy codes as "123 456"). */
export function readEvidenceCode(value: string): string | null {
  const digits = value.replace(/\s+/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** Why the link no longer opens, from the API's 410 and 403 refusals. */
export type LinkEnded = "revoked" | "expired" | "locked" | "not_released" | "wrong_recipient";

export type EvidenceLinkResult =
  | { readonly kind: "sent" }
  /** The code was made but the email did not go: ask again in a moment. */
  | { readonly kind: "not_sent" }
  | { readonly kind: "verified" }
  | { readonly kind: "wrong_code" }
  | { readonly kind: "malformed" }
  | { readonly kind: "throttled"; readonly minutes: number }
  | { readonly kind: "ended"; readonly reason: LinkEnded }
  /** No session for this link in this browser: the code is needed (again). */
  | { readonly kind: "code_required" }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

const ENDED = new Set<string>(["revoked", "expired", "locked", "not_released", "wrong_recipient"]);

/** Whole minutes to wait from a Retry-After header, at least one. */
export function retryMinutes(retryAfter: string | null | undefined): number {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * A refused call in the page's terms, from the status, the problem's code (`link_revoked`,
 * `wrong_code`, `too_many_codes`) and Retry-After. Anything else is "unavailable": never a
 * guess that might send the inspector the wrong way.
 */
export function linkRefusal(
  status: number,
  code: string | undefined,
  retryAfter: string | null,
): EvidenceLinkResult {
  if (status === 429) return { kind: "throttled", minutes: retryMinutes(retryAfter) };
  if (status === 404) return { kind: "not_found" };
  if (code === "wrong_code") return { kind: "wrong_code" };
  if (status === 401 || code === "link_code_required") return { kind: "code_required" };
  const reason = code?.startsWith("link_") ? code.slice(5) : undefined;
  if ((status === 410 || status === 403) && reason && ENDED.has(reason)) {
    return { kind: "ended", reason: reason as LinkEnded };
  }
  // The API refuses a malformed code or token with 422 before counting anything.
  if (status === 422 || status === 400) return { kind: "malformed" };
  return { kind: "unavailable" };
}

/** Results after which the link will never open again, so the page stops offering a code. */
export function isFinal(result: EvidenceLinkResult): boolean {
  return result.kind === "ended" || result.kind === "not_found";
}

/** The file name the browser saves the pack as: no person, recipient or pack details. */
export const BUNDLE_FILE_NAME = "evidence-pack.pdf";

/** The API's session cookie for one evidence link (HttpOnly, Secure, SameSite=Strict). */
export const EVIDENCE_SESSION_COOKIE = "__Host-harbour_evidence_session";

/**
 * The session cookie's value from a Cookie header, or null: the only cookie the bundle route
 * passes on to the API (#113 security review I1).
 */
export function sessionCookie(header: string | null): string | null {
  for (const part of header?.split(";") ?? []) {
    const [name, ...rest] = part.trim().split("=");
    if (name === EVIDENCE_SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}
