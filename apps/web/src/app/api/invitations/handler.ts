import { isSameOrigin } from "@/lib/invitations";

/**
 * The invitation page's two calls (POST, JSON, same origin only). The browser reaches the API only
 * through /api/auth and these, so the token travels in a body, never in a URL (PLAT-004).
 */
export async function invitationRequest<T>(
  request: Request,
  answer: (body: Record<string, unknown>) => Promise<T>,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  // A cross-site form cannot post JSON with this origin, so another site cannot accept for someone.
  if (
    !isSameOrigin(
      request.headers.get("origin"),
      request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    ) ||
    !request.headers.get("content-type")?.startsWith("application/json")
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
