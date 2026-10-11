/**
 * Maps the API's RFC 9457 problem codes to where the person should go next. Pure, so the mapping
 * is unit tested; the server helpers in api.ts perform the redirect.
 */

export const PROBLEM_CODES = [
  "unauthenticated",
  "tenant_required",
  "not_a_member",
  "missing_permission",
  "mfa_enrolment_required",
  "step_up_required",
  "not_found",
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * Accepts only a same-origin path ("/people/123"), never an absolute or protocol-relative URL, so a
 * crafted ?next= cannot send someone to another site after they sign in.
 */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  // Control characters and backslashes are never part of a Harbour path.
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "\\") return null;
  }
  return value;
}

function withNext(base: string, nextPath: string | undefined, extra?: Record<string, string>) {
  const params = new URLSearchParams(extra);
  const next = safeNextPath(nextPath);
  if (next && next !== "/") params.set("next", next);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Where to send the person for a problem code, or null when the page should handle it in place
 * (for example "not found" or "missing permission", which get their own message).
 */
export function redirectForProblem(code: string | undefined, nextPath?: string): string | null {
  switch (code) {
    case "unauthenticated":
      return withNext("/sign-in", nextPath);
    case "step_up_required":
      return withNext("/sign-in", nextPath, { reason: "step-up" });
    case "tenant_required":
    case "not_a_member":
      return withNext("/choose-organisation", nextPath);
    case "mfa_enrolment_required":
      return "/settings/security?reason=mfa";
    default:
      return null;
  }
}
