/**
 * When a refusal means the session, or the access behind it, has ended (security reviews round 3
 * H1 and round 4 H1).
 *
 * A 401 always means the session has ended. A 403 is read from its RFC 9457 problem body:
 *
 * - a session code (`not_a_member`, `mfa_enrolment_required`, `step_up_required`): the session
 *   has ended;
 * - any other code the API sends (`missing_permission`, `feature_disabled`, or one this build does
 *   not know): on the sync token, the access Care mode needs has been withdrawn, so the device holds
 *   its unsent work (or wipes when there is none); on a single entry, that entry was refused;
 * - no JSON body, an HTML page, or the web application firewall's `edge_blocked`: the request never
 *   reached the API's decision, so the device asks `GET /v1/me` before acting, and never wipes or
 *   holds on that alone.
 */

/** Problem codes the API sends with a 403 that is about the session, not the request. */
export const SESSION_PROBLEM_CODES: ReadonlySet<string> = new Set([
  "not_a_member",
  "mfa_enrolment_required",
  "step_up_required",
]);

/** The code the web application firewall sends with its own 403 (`infra/modules/waf`). */
export const EDGE_BLOCKED_CODE = "edge_blocked";

/**
 * The permission Care mode needs, the one `POST /v1/sync/token` asks for: without it the device
 * cannot sync, so `GET /v1/me` answering without it means the access has been withdrawn.
 */
export const CARE_ACCESS_PERMISSION = "people.person.read";

/** Request header naming the organisation, for staff who belong to more than one. */
export const TENANT_HEADER = "x-harbour-tenant";

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

/**
 * session: the session has ended. api: the API refused on purpose (access withdrawn on the token,
 * or this entry refused). unexplained: no API decision is visible (no body, HTML, the edge), so
 * `GET /v1/me` decides.
 */
export type ForbiddenKind = "session" | "api" | "unexplained";

export function classifyForbidden(code: string | null): ForbiddenKind {
  if (code === null || code === EDGE_BLOCKED_CODE) return "unexplained";
  return isSessionProblem(code) ? "session" : "api";
}

export type SessionCheck = "ok" | "ended" | "unknown";

/**
 * Asks `GET /v1/me` whether the session stands, in the session's organisation: "ok" when it
 * answers with the permission Care mode needs; "ended" on a 401, a session-level 403, or an answer
 * without that permission; "unknown" for anything else (no network, an edge block, a server error).
 */
export async function checkSession(options: {
  readonly apiUrl: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly token: string | null;
  readonly tenantId: string | null;
}): Promise<SessionCheck> {
  if (!options.token) return "ended";
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/me`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.token}`,
        ...(options.tenantId ? { [TENANT_HEADER]: options.tenantId } : {}),
      },
      credentials: "omit",
    });
    if (response.ok) {
      const body: unknown = await response.json().catch(() => null);
      // An answer that cannot be read decides nothing.
      if (!isRecord(body) || !Array.isArray(body.permissions)) return "unknown";
      return body.permissions.includes(CARE_ACCESS_PERMISSION) ? "ok" : "ended";
    }
    if (response.status === 401) return "ended";
    if (response.status === 403) {
      return isSessionProblem((await readProblemBody(response)).code) ? "ended" : "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
