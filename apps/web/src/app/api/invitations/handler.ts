import { isJsonMediaType, isSameOrigin } from "@/lib/invitations";
import { readJsonBody } from "@/lib/json-body";

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
  // At most a few KiB, however it is sent (#113 security review L1).
  const read = await readJsonBody(request);
  if (!read.ok) {
    return Response.json(
      { kind: read.status === 413 ? "too_large" : "invalid" },
      { status: read.status, headers },
    );
  }
  return Response.json(await answer(read.body), { headers });
}

export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
