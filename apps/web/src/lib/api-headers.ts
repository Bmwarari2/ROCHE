import { clientAddress } from "./client-address";
import { REQUEST_ID_HEADER, wellFormedRequestId } from "./request-id";

/** Request headers passed on as they came: the session cookie, and the user agent the audit records. */
const FORWARDED = ["cookie", "user-agent"] as const;

/**
 * What the server-side API client passes on from the browser's request (`serverApi` in api.ts):
 * the session cookie and user agent, the request id only when it is well formed (request-id.ts),
 * and only the client address the trusted proxies saw, never what the client wrote to the left
 * of it (client-address.ts). Nothing else.
 */
export function apiRequestHeaders(
  incoming: Pick<Headers, "get">,
  trustedCidrs: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value) out[name] = value;
  }
  const requestId = wellFormedRequestId(incoming.get(REQUEST_ID_HEADER));
  if (requestId) out[REQUEST_ID_HEADER] = requestId;
  const address = clientAddress(incoming.get("x-forwarded-for"), trustedCidrs);
  if (address) out["x-forwarded-for"] = address;
  return out;
}
