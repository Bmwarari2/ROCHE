import { API_URL } from "@/lib/api";
import {
  attemptOfToken,
  contentCsp,
  contentHeaders,
  contentOrigin,
  isContentHost,
  isLaunchToken,
  packagePathOf,
  runtimeCsp,
  runtimePage,
} from "@/lib/elearning";
import { RUNTIME_SOURCE } from "@/lib/elearning-runtime";
import { webOrigin } from "@/lib/invitations";

/**
 * The content origin (ADR-0093). Answers only when the request reached this server under the
 * content origin's host (`ELEARNING_ORIGIN`), so package content never runs on the app's origin:
 *
 * - `/learn/{token}/`: Harbour's runtime page (the SCORM API and the package frame), framed only
 *   by the app;
 * - `/learn/{token}/_harbour/runtime.js`: its script;
 * - `/learn/{token}/c/{path}`: a file of the token's course, fetched from the API, which checks
 *   the token and serves only the package's own files of allowlisted types;
 * - `POST /learn/{token}/xapi/statements`: an xAPI statement batch, passed to the API, which keeps
 *   them for the token's attempt only.
 *
 * No cookies reach this host (it is another site), and nothing here reads a session.
 */

type Params = Promise<{ token: string; path?: string[] }>;

const notFound = () =>
  new Response("Not found", {
    status: 404,
    headers: {
      ...contentHeaders("default-src 'none'"),
      "content-type": "text/plain; charset=utf-8",
    },
  });

function gate(request: Request, token: string): { origin: string; app: string } | null {
  const origin = contentOrigin();
  const app = webOrigin();
  if (!origin || !app || !isLaunchToken(token)) return null;
  if (!isContentHost(request.headers.get("host"), origin)) return null;
  return { origin, app: new URL(app).origin };
}

export async function GET(request: Request, { params }: { params: Params }): Promise<Response> {
  const { token, path = [] } = await params;
  const where = gate(request, token);
  if (!where) return notFound();
  if (path.length === 0) {
    const attemptId = attemptOfToken(token);
    if (!attemptId) return notFound();
    return new Response(
      runtimePage({ appOrigin: where.app, attemptId, title: "Course", base: `/learn/${token}` }),
      {
        headers: {
          ...contentHeaders(runtimeCsp(where.app)),
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  }
  if (path.length === 2 && path[0] === "_harbour" && path[1] === "runtime.js") {
    return new Response(RUNTIME_SOURCE, {
      headers: {
        ...contentHeaders("default-src 'none'"),
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }
  if (path[0] === "c") {
    const file = packagePathOf(path.slice(1));
    if (!file) return notFound();
    const upstream = await fetch(`${API_URL}/e/launch/${token}/files/${encodeURIComponent(file)}`, {
      cache: "no-store",
      redirect: "error",
    }).catch(() => null);
    if (!upstream?.ok || !upstream.body) return notFound();
    return new Response(upstream.body, {
      headers: {
        ...contentHeaders(contentCsp(where.app)),
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      },
    });
  }
  // xAPI state and activity profile reads: nothing is kept for them (ADR-0093).
  if (path[0] === "xapi")
    return new Response(null, { status: 404, headers: contentHeaders("default-src 'none'") });
  return notFound();
}

export async function POST(request: Request, { params }: { params: Params }): Promise<Response> {
  const { token, path = [] } = await params;
  const where = gate(request, token);
  if (!where || path.join("/") !== "xapi/statements") return notFound();
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isInteger(length) || length > 900 * 1024) {
    return new Response(null, { status: 413, headers: contentHeaders("default-src 'none'") });
  }
  const body = await request.text();
  if (body.length > 900 * 1024) {
    return new Response(null, { status: 413, headers: contentHeaders("default-src 'none'") });
  }
  const upstream = await fetch(`${API_URL}/e/launch/${token}/statements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
    redirect: "error",
  }).catch(() => null);
  if (!upstream)
    return new Response(null, { status: 502, headers: contentHeaders("default-src 'none'") });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { ...contentHeaders("default-src 'none'"), "content-type": "application/json" },
  });
}

/** xAPI state writes are accepted and not kept (ADR-0093); anything else is refused. */
export async function PUT(request: Request, { params }: { params: Params }): Promise<Response> {
  const { token, path = [] } = await params;
  const where = gate(request, token);
  if (!where || path[0] !== "xapi") return notFound();
  return new Response(null, { status: 204, headers: contentHeaders("default-src 'none'") });
}
