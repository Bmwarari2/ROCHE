/**
 * When a refusal means the session has ended (security review round 3, H1).
 *
 * A 401 always means the session has ended. A 403 means it only when the API itself says so: an
 * RFC 9457 problem body (`application/problem+json` or `application/json`) whose `code` is one of
 * the session-level codes in `apps/api/src/http/problem.ts`. A 403 from anything else (the web
 * application firewall at the edge, a proxy, a rate limit, an HTML error page, an empty body, or a
 * code this build does not know) is not evidence that the session has ended, so it never wipes or
 * holds the device: the caller asks `GET /v1/me` first and acts on that answer.
 */

/** Problem codes the API sends with a 403 that is about the session, not the request. */
export const SESSION_PROBLEM_CODES: ReadonlySet<string> = new Set([
  "not_a_member",
  "mfa_enrolment_required",
  "step_up_required",
]);

export interface ProblemSummary {
  /** The problem `code`, or null when the body is not a JSON problem. */
  readonly code: string | null;
  /** The API's plain-English reason: the detail when there is one, otherwise the title. */
  readonly reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a JSON problem body; anything else (HTML, text, empty) reads as no code. Never throws. */
export async function readProblemBody(response: Response): Promise<ProblemSummary> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("json")) return { code: null, reason: null };
  try {
    const body: unknown = await response.json();
    if (!isRecord(body)) return { code: null, reason: null };
    const code = typeof body.code === "string" && body.code ? body.code : null;
    const detail = typeof body.detail === "string" && body.detail ? body.detail : null;
    const title = typeof body.title === "string" && body.title ? body.title : null;
    return { code, reason: detail ?? title };
  } catch {
    return { code: null, reason: null };
  }
}

/** True when a 403's problem code says the session itself has ended. */
export function isSessionProblem(code: string | null): boolean {
  return code !== null && SESSION_PROBLEM_CODES.has(code);
}

export type SessionCheck = "ok" | "ended" | "unknown";

/**
 * Asks `GET /v1/me` whether the session still stands: "ok" when it answers, "ended" on a 401 or a
 * session-level 403, and "unknown" for anything else (no network, an edge block, a server error).
 */
export async function checkSession(options: {
  readonly apiUrl: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly token: string | null;
}): Promise<SessionCheck> {
  if (!options.token) return "ended";
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/me`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${options.token}` },
      credentials: "omit",
    });
    if (response.ok) return "ok";
    if (response.status === 401) return "ended";
    if (response.status === 403) {
      return isSessionProblem((await readProblemBody(response)).code) ? "ended" : "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
