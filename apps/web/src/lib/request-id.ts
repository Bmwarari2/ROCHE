/**
 * The request id passed on to the API: a UUID or up to 64 letters, digits and hyphens, as the API
 * itself accepts (`apps/api/src/http/request-id.ts`). The API writes it to every audit row of the
 * request, so anything else the browser sent is not forwarded and the API makes its own id
 * (security review, 31 October 2026). Every place that forwards `x-request-id` uses this.
 */
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;

export const REQUEST_ID_HEADER = "x-request-id";

/** The id when it is well formed, otherwise null (nothing is forwarded). */
export function wellFormedRequestId(value: string | null | undefined): string | null {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}
