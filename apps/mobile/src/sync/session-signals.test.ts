import { describe, expect, it } from "vitest";
import {
  CARE_ACCESS_PERMISSION,
  checkSession,
  classifyForbidden,
  readProblemBody,
  TENANT_HEADER,
} from "./session-signals";

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

function probe(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, calls };
}

describe("classifyForbidden (security review round 4, H1)", () => {
  it.each([
    ["not_a_member", "session"],
    ["mfa_enrolment_required", "session"],
    ["step_up_required", "session"],
    ["missing_permission", "api"],
    ["feature_disabled", "api"],
    ["a_code_this_build_does_not_know", "api"],
    ["edge_blocked", "unexplained"],
    [null, "unexplained"],
  ] as const)("reads a 403 with code %s as %s", (code, kind) => {
    expect(classifyForbidden(code)).toBe(kind);
  });
});

describe("readProblemBody", () => {
  it("reads the code and prefers the detail", async () => {
    await expect(
      readProblemBody(json({ code: "missing_permission", title: "T", detail: "D" }, 403)),
    ).resolves.toEqual({ code: "missing_permission", reason: "D" });
  });

  it.each([
    ["an HTML page", new Response("<html></html>", { headers: { "content-type": "text/html" } })],
    ["an empty body", new Response("", { status: 403 })],
    ["broken JSON", new Response("{", { headers: { "content-type": "application/json" } })],
    ["a JSON array", json([1, 2])],
  ])("reads %s as no code", async (_case, response) => {
    await expect(readProblemBody(response)).resolves.toEqual({ code: null, reason: null });
  });
});

describe("checkSession (security review round 4, H1)", () => {
  const ask = (fetch: (url: string, init?: RequestInit) => Promise<Response>, tenantId = TENANT) =>
    checkSession({ apiUrl: API, fetch, token: "tok", tenantId });

  it("asks /v1/me in the session's organisation", async () => {
    const { fetch, calls } = probe(json({ permissions: [CARE_ACCESS_PERMISSION] }));
    await expect(ask(fetch)).resolves.toBe("ok");
    expect(calls[0]?.url).toBe(`${API}/v1/me`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
  });

  it("answers ended when /v1/me lacks the permission Care mode needs", async () => {
    const { fetch } = probe(json({ permissions: ["care.note.write"] }));
    await expect(ask(fetch)).resolves.toBe("ended");
  });

  it("answers ended without a token, on a 401, and on a session-level 403", async () => {
    await expect(
      checkSession({ apiUrl: API, fetch: probe(json({})).fetch, token: null, tenantId: TENANT }),
    ).resolves.toBe("ended");
    await expect(ask(probe(json({}, 401)).fetch)).resolves.toBe("ended");
    await expect(ask(probe(json({ code: "not_a_member" }, 403)).fetch)).resolves.toBe("ended");
  });

  it.each([
    ["an answer without permissions", () => json({})],
    ["an edge block", () => json({ code: "edge_blocked" }, 403)],
    ["a server error", () => json({}, 503)],
    ["no network", () => new TypeError("Network request failed")],
  ])("answers unknown for %s, deciding nothing", async (_case, response) => {
    await expect(ask(probe(response()).fetch)).resolves.toBe("unknown");
  });
});
