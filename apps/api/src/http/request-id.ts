/**
 * Request ids (security reviews, 31 October 2026 and of #134, M4). The id on every audit row of a
 * request (`audit_event.request_id`, append-only and hash-chained) and in the response's
 * `x-request-id` is always one the API made itself, so nothing a caller writes (personal data, or
 * another request's id to forge a correlation) ever reaches the audit chain. A caller's own id is
 * kept only in the log, next to the API's, and only when it is a canonical UUID.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The caller's `x-request-id` when it is a canonical (lower-case) UUID, otherwise null. */
export function callerRequestIdOf(header: string | null | undefined): string | null {
  return typeof header === "string" && CANONICAL_UUID.test(header) ? header : null;
}
