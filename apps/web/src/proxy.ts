import { type NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy, createNonce } from "@/lib/csp";
import { contentOrigin, ELEARNING_PAGE, isContentHost } from "@/lib/elearning";

/**
 * A fresh CSP nonce for every page. Next.js reads the nonce from the request's
 * Content-Security-Policy header and puts it on its own script tags, so every page must render
 * dynamically (they all read the session cookie).
 */
export function proxy(request: NextRequest) {
  const content = contentOrigin();
  // The e-learning content origin serves only `/learn` (its route handler); no app page, ever, is
  // answered under that host, so package content can never reach one same-origin (ADR-0093).
  if (isContentHost(request.headers.get("host"), content)) {
    return new NextResponse("Not found", { status: 404 });
  }
  // Route handlers and prefetches pass the host check above and take nothing else here: the
  // matcher includes them so the content host can never reach one (review M4).
  if (
    request.nextUrl.pathname.startsWith("/api/") ||
    request.nextUrl.pathname === "/api" ||
    request.headers.has("next-router-prefetch") ||
    request.headers.get("purpose") === "prefetch"
  ) {
    return NextResponse.next();
  }
  // Only the course player may frame the content origin.
  const frames =
    content && request.nextUrl.pathname.startsWith(`${ELEARNING_PAGE}/`) ? [content] : [];
  const policy = contentSecurityPolicy(
    createNonce(),
    process.env.NODE_ENV === "development",
    frames,
  );
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Every page, route handler and prefetch, so the content host check always runs (review
      // M4); the policy itself is set on pages only (above). Not static chunks, and not the
      // content origin's route handler (`/learn`), which sets its own headers. On the edge, the
      // content host forwards `/learn/*` only.
      source: "/((?!learn/|_next/static|_next/image|favicon.ico).*)",
    },
  ],
};
