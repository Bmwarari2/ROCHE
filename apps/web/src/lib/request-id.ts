/**
 * The request id passed on to the API: only a canonical (lower-case) UUID, which the API keeps
 * only in its log beside its own id (`apps/api/src/http/request-id.ts`); the audit trail always
 * gets the API's own id. Anything else the browser sent is not forwarded (security reviews, 31
 * October 2026 and of #134, M4). Every place that forwards `x-request-id` uses this.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const REQUEST_ID_HEADER = "x-request-id";

/** The id when it is a canonical UUID, otherwise null (nothing is forwarded). */
export function wellFormedRequestId(value: string | null | undefined): string | null {
  return typeof value === "string" && CANONICAL_UUID.test(value) ? value : null;
}
