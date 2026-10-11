/**
 * Header rules for passing the browser's Better Auth calls (/api/auth/*) through to the API at
 * run time. The API's address comes from the environment when the server starts, so one image
 * serves every environment. Pure, unit tested; used by `app/api/auth/[...path]/route.ts`.
 */

/** Connection-level headers that describe one hop and must not be forwarded (RFC 9110 7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers the API must not see from the browser. */
const DROPPED_REQUEST = new Set([
  ...HOP_BY_HOP,
  "host",
  "content-length",
  // The server-side fetch negotiates its own compression and decodes the body.
  "accept-encoding",
  // Next.js routing and React Server Components internals.
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-url",
  "x-middleware-subrequest",
]);

/** Response headers that no longer hold once the body has been decoded and re-streamed. */
const DROPPED_RESPONSE = new Set([...HOP_BY_HOP, "content-encoding", "content-length"]);

export function forwardRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of incoming) {
    if (!DROPPED_REQUEST.has(name) && !name.startsWith("x-middleware-")) out.append(name, value);
  }
  return out;
}

export function forwardResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of upstream) {
    if (name === "set-cookie" || DROPPED_RESPONSE.has(name)) continue;
    out.append(name, value);
  }
  // Each cookie stays a separate header; joining them would corrupt their attributes.
  for (const cookie of upstream.getSetCookie()) out.append("set-cookie", cookie);
  out.set("cache-control", "no-store");
  return out;
}

/** The API URL for a browser request to this app, keeping the path and query. */
export function upstreamUrl(apiUrl: string, requestUrl: string): string {
  const { pathname, search } = new URL(requestUrl);
  return `${apiUrl}${pathname}${search}`;
}
