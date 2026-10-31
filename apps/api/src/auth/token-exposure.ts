/**
 * The mobile app's origin (its deep-link scheme). Browsers cannot send it: Origin is a header that
 * page scripts are not allowed to set.
 */
export const MOBILE_APP_ORIGIN = "harbour://";

/**
 * With the bearer plugin a session token is a complete credential. Only the mobile app, which
 * keeps it in the device keychain, receives one. Browsers and the web server rely on the httpOnly
 * session cookie, so a script injected into a page cannot read a token from a sign-in or session
 * response (ASVS 5.0 V7). Removes the `set-auth-token` header and every `token` field from JSON
 * bodies for any other caller.
 */
export async function withoutSessionTokens(
  request: Request,
  response: Response,
): Promise<Response> {
  // Other sessions' tokens are never anyone's to see, not even the mobile app's (#33 re-check H2).
  const listing = new URL(request.url).pathname.endsWith("/list-sessions");
  if (request.headers.get("origin") === MOBILE_APP_ORIGIN && !listing) return response;
  const headers = new Headers(response.headers);
  headers.delete("set-auth-token");
  const init = { status: response.status, statusText: response.statusText, headers };
  const isJson = (headers.get("content-type") ?? "").includes("application/json");
  if (!isJson || response.body === null) return new Response(response.body, init);

  const text = await response.text();
  headers.delete("content-length");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, init);
  }
  return new Response(JSON.stringify(redactTokens(body, 0)), init);
}

const MAX_DEPTH = 6;

function redactTokens(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactTokens(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "token")
        .map(([key, item]) => [key, redactTokens(item, depth + 1)]),
    );
  }
  return value;
}
