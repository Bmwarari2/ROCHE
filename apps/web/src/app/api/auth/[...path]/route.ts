import { API_URL } from "@/lib/api";
import { forwardRequestHeaders, forwardResponseHeaders, upstreamUrl } from "@/lib/api-proxy";

/**
 * Better Auth for the browser: sign-in, passkeys, TOTP and sign-out go to /api/auth on this
 * origin and are passed to the API, so the session cookie is first-party and httpOnly. The API
 * never returns session tokens here (only the mobile app gets one). Everything else the web app
 * needs from the API is fetched on the server, so /v1 is not exposed to the browser.
 */
async function pass(request: Request): Promise<Response> {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(upstreamUrl(API_URL, request.url), {
    method: request.method,
    headers: forwardRequestHeaders(request.headers),
    redirect: "manual",
    cache: "no-store",
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardResponseHeaders(upstream.headers),
  });
}

export const GET = pass;
export const POST = pass;
