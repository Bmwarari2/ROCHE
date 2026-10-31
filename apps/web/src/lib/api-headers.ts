import { clientAddress } from "./client-address";
import { REQUEST_ID_HEADER, wellFormedRequestId } from "./request-id";

/**
 * What the API is told about the caller, for its audit trail and throttles: the user agent, the
 * request id only when it is well formed (request-id.ts), and only the client address the trusted
 * proxies saw, never what the client wrote to the left of it (client-address.ts). No credentials:
 * the public evidence pages (evidence-link-server.ts) send exactly this.
 */
export function callerHeaders(
  incoming: Pick<Headers, "get">,
  trustedCidrs: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const agent = incoming.get("user-agent");
  if (agent) out["user-agent"] = agent;
  const requestId = wellFormedRequestId(incoming.get(REQUEST_ID_HEADER));
  if (requestId) out[REQUEST_ID_HEADER] = requestId;
  const address = clientAddress(incoming.get("x-forwarded-for"), trustedCidrs);
  if (address) out["x-forwarded-for"] = address;
  return out;
}

/**
 * What the server-side API client passes on from the browser's request (`serverApi` in api.ts):
 * the session cookie and `callerHeaders`. Nothing else.
 */
export function apiRequestHeaders(
  incoming: Pick<Headers, "get">,
  trustedCidrs: readonly string[],
): Record<string, string> {
  const cookie = incoming.get("cookie");
  return { ...(cookie ? { cookie } : {}), ...callerHeaders(incoming, trustedCidrs) };
}
