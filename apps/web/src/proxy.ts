import { type NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy, createNonce } from "@/lib/csp";

/**
 * A fresh CSP nonce for every page. Next.js reads the nonce from the request's
 * Content-Security-Policy header and puts it on its own script tags, so every page must render
 * dynamically (they all read the session cookie).
 */
export function proxy(request: NextRequest) {
  const policy = contentSecurityPolicy(createNonce(), process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not route handlers under /api, static chunks or prefetches.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
