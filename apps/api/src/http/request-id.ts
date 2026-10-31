/**
 * The request id a caller may choose: a UUID or up to 64 letters, digits and hyphens. It is
 * written to every audit row of the request (`audit_event.request_id`, append-only and
 * hash-chained) and echoed in the response, so free text in it would put whatever the caller
 * wrote (personal data included) into the audit chain for good, and let them forge the log
 * correlation (security review, 31 October 2026).
 */
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The caller's request id when it is well formed, otherwise null (the API then makes its own). */
export function requestIdOf(header: string | null | undefined): string | null {
  return typeof header === "string" && REQUEST_ID.test(header) ? header : null;
}
