import { isJsonMediaType, isSameOrigin } from "@/lib/invitations";

/**
 * This site's origin from configuration (`PUBLIC_WEB_URL`, set per environment by Terraform). In
 * development the local web server's address; in production without it, nothing matches.
 */
function webOrigin(): string | null {
  return (
    process.env.PUBLIC_WEB_URL ??
    (process.env.NODE_ENV === "production" ? null : "http://localhost:3000")
  );
}

/**
 * The invitation page's two calls (POST, JSON, same origin only). The browser reaches the API only
 * through /api/auth and these, so the token travels in a body, never in a URL (PLAT-004).
 */
export async function invitationRequest<T>(
  request: Request,
  answer: (body: Record<string, unknown>) => Promise<T>,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  // Only this site, posting JSON: a cross-site form cannot accept an invitation for someone.
  if (
    !isSameOrigin(request.headers.get("origin"), webOrigin()) ||
    !isJsonMediaType(request.headers.get("content-type"))
  ) {
    return Response.json({ kind: "forbidden" }, { status: 403, headers });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ kind: "invalid" }, { status: 400, headers });
  }
  return Response.json(await answer(body as Record<string, unknown>), { headers });
}

export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
