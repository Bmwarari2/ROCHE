import "server-only";
import { headers } from "next/headers";
import { API_URL } from "./api";
import { clientAddress, trustedProxies } from "./client-address";
import {
  type EvidenceLinkResult,
  isEvidenceToken,
  linkRefusal,
  readEvidenceCode,
} from "./evidence-link";
import { isJsonMediaType, isSameOrigin } from "./invitations";
import { webOrigin } from "./quality-server";

/**
 * The public evidence page's calls to the API (`/p/evidence/*`; ADR-0050; HZ-050), behind the route
 * handlers in app/api/evidence. The token arrives in a JSON body and goes on in a body; nothing here
 * logs, stores or returns it. Only this site may post (the Origin is this site's configured one,
 * never read from the request), and only JSON. The API's session cookie for the link is passed back
 * as it is set: HttpOnly, Secure, SameSite=Strict.
 */

const TRUSTED_PROXIES = trustedProxies(process.env.TRUSTED_PROXY_CIDRS);
const NO_STORE = { "cache-control": "no-store" } as const;

/** What the API is told about the caller: the user agent and the address the proxies saw. */
async function forwarded(): Promise<Record<string, string>> {
  const incoming = await headers();
  const out: Record<string, string> = {};
  const agent = incoming.get("user-agent");
  if (agent) out["user-agent"] = agent;
  const requestId = incoming.get("x-request-id");
  if (requestId) out["x-request-id"] = requestId;
  const address = clientAddress(incoming.get("x-forwarded-for"), TRUSTED_PROXIES);
  if (address) out["x-forwarded-for"] = address;
  return out;
}

async function problemCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

async function post(path: "code" | "verify", body: object): Promise<Response | null> {
  try {
    return await fetch(`${API_URL}/p/evidence/${path}`, {
      method: "POST",
      headers: { ...(await forwarded()), "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return null;
  }
}

/** Reads a same-origin JSON post, or the refusal to send back. */
async function readPost(request: Request): Promise<Record<string, unknown> | Response> {
  if (
    !isSameOrigin(request.headers.get("origin"), webOrigin()) ||
    !isJsonMediaType(request.headers.get("content-type"))
  ) {
    return Response.json({ kind: "unavailable" }, { status: 403, headers: NO_STORE });
  }
  try {
    const body = (await request.json()) as unknown;
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  } catch {
    // Falls through to the refusal.
  }
  return Response.json({ kind: "malformed" }, { status: 400, headers: NO_STORE });
}

const answer = (result: EvidenceLinkResult, extra?: Headers) => {
  const out = new Headers(NO_STORE);
  for (const cookie of extra?.getSetCookie() ?? []) out.append("set-cookie", cookie);
  return Response.json(result, { headers: out });
};

/** POST /api/evidence/code: email a one-time code to the link's recipient. */
export async function sendCode(request: Request): Promise<Response> {
  const body = await readPost(request);
  if (body instanceof Response) return body;
  if (!isEvidenceToken(body.token)) return answer({ kind: "not_found" });
  const response = await post("code", { token: body.token });
  if (!response) return answer({ kind: "unavailable" });
  if (response.status === 202) {
    const sent = (await response.json().catch(() => ({}))) as { sent?: unknown };
    return answer({ kind: sent.sent === true ? "sent" : "not_sent" });
  }
  return answer(
    linkRefusal(response.status, await problemCode(response), response.headers.get("retry-after")),
  );
}

/** POST /api/evidence/verify: check the code; a right one sets the link's session cookie. */
export async function verifyCode(request: Request): Promise<Response> {
  const body = await readPost(request);
  if (body instanceof Response) return body;
  if (!isEvidenceToken(body.token)) return answer({ kind: "not_found" });
  const code = typeof body.code === "string" ? readEvidenceCode(body.code) : null;
  // Not six digits: refused here, never sent, never counted.
  if (!code) return answer({ kind: "malformed" });
  const response = await post("verify", { token: body.token, code });
  if (!response) return answer({ kind: "unavailable" });
  if (response.status === 204) return answer({ kind: "verified" }, response.headers);
  return answer(
    linkRefusal(response.status, await problemCode(response), response.headers.get("retry-after")),
  );
}

/**
 * GET /api/evidence/bundle: the watermarked pack, streamed from the API with the browser's cookie
 * for this link (the only credential), never stored here. A refusal comes back as JSON the page
 * says in words.
 */
export async function openBundle(request: Request): Promise<Response> {
  const cookie = request.headers.get("cookie");
  let response: Response;
  try {
    response = await fetch(`${API_URL}/p/evidence/bundle`, {
      headers: { ...(await forwarded()), ...(cookie ? { cookie } : {}) },
      cache: "no-store",
    });
  } catch {
    return answer({ kind: "unavailable" });
  }
  if (response.ok && response.body) {
    return new Response(response.body, {
      status: 200,
      headers: {
        ...NO_STORE,
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="evidence-pack.pdf"',
        "x-content-type-options": "nosniff",
      },
    });
  }
  return Response.json(
    linkRefusal(response.status, await problemCode(response), response.headers.get("retry-after")),
    { status: 200, headers: NO_STORE },
  );
}
