import { describe, expect, it } from "vitest";
import { AuthError, createAuthClient, normaliseTotpCode, parseMe } from "./auth-client";
import type { FetchLike } from "./http";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(responses: Array<Response | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("No more fake responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const me = {
  user: { id: "u1", name: "Ada Example" },
  tenant: { id: "t1", name: "Example Care Ltd" },
  tenantUserId: "tu-1",
  locations: [{ id: "l1", name: "Example House" }],
  permissions: ["people.person.read"],
};

const client = (fetch: FetchLike) =>
  createAuthClient({ baseUrl: "https://api.example.invalid", fetch, origin: "harbour://" });

function headerOf(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

describe("signInWithEmail", () => {
  it("returns the bearer token from the set-auth-token header", async () => {
    const { fetch, calls } = fakeFetch([
      json({ redirect: false, token: "body-token" }, { headers: { "set-auth-token": "tok.sig" } }),
    ]);
    await expect(client(fetch).signInWithEmail(" ada@example.invalid ", "pw")).resolves.toEqual({
      kind: "signed_in",
      token: "tok.sig",
    });
    expect(calls[0]?.url).toBe("https://api.example.invalid/api/auth/sign-in/email");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect(headerOf(calls[0], "origin")).toBe("harbour://");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      email: "ada@example.invalid",
      password: "pw",
    });
  });

  it("falls back to the token in the body", async () => {
    const { fetch } = fakeFetch([json({ token: "body-token" })]);
    await expect(client(fetch).signInWithEmail("a@example.invalid", "pw")).resolves.toEqual({
      kind: "signed_in",
      token: "body-token",
    });
  });

  it("returns a two-factor challenge carrying the pending cookie", async () => {
    const { fetch } = fakeFetch([
      json(
        { twoFactorRedirect: true },
        {
          headers: {
            "set-cookie":
              "better-auth.two_factor=abc.def; Max-Age=600; Path=/; HttpOnly; Expires=Fri, 09 Oct 2026 13:15:00 GMT, other=1; Path=/",
          },
        },
      ),
    ]);
    await expect(client(fetch).signInWithEmail("a@example.invalid", "pw")).resolves.toEqual({
      kind: "two_factor_required",
      challenge: { cookie: "better-auth.two_factor=abc.def; other=1" },
    });
  });

  it.each([
    [401, "invalid_credentials"],
    [400, "invalid_credentials"],
    [403, "invalid_credentials"],
    [429, "rate_limited"],
    [500, "server"],
    [503, "server"],
    [418, "unexpected"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const { fetch } = fakeFetch([json({ code: "X" }, { status })]);
    await expect(client(fetch).signInWithEmail("a@example.invalid", "pw")).rejects.toMatchObject({
      kind,
    });
  });

  it("reports a network failure without blaming the user", async () => {
    const { fetch } = fakeFetch([new TypeError("Network request failed")]);
    const error = await client(fetch)
      .signInWithEmail("a@example.invalid", "pw")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).kind).toBe("network");
    expect((error as AuthError).message).toMatch(/cannot be reached/);
  });

  it("treats a success without a token as a server error", async () => {
    const { fetch } = fakeFetch([json({ redirect: false })]);
    await expect(client(fetch).signInWithEmail("a@example.invalid", "pw")).rejects.toMatchObject({
      kind: "server",
    });
  });
});

describe("verifyTotp", () => {
  it("sends the code with the challenge cookie and returns the token", async () => {
    const { fetch, calls } = fakeFetch([json({}, { headers: { "set-auth-token": "tok2" } })]);
    await expect(
      client(fetch).verifyTotp({ cookie: "better-auth.two_factor=abc" }, "123 456"),
    ).resolves.toBe("tok2");
    expect(calls[0]?.url).toBe("https://api.example.invalid/api/auth/two-factor/verify-totp");
    expect(headerOf(calls[0], "cookie")).toBe("better-auth.two_factor=abc");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: "123456" });
  });

  it("rejects a malformed code without a request", async () => {
    const { fetch, calls } = fakeFetch([]);
    await expect(client(fetch).verifyTotp({ cookie: "" }, "12345")).rejects.toMatchObject({
      kind: "invalid_code",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps a rejected code to invalid_code", async () => {
    const { fetch } = fakeFetch([json({ code: "INVALID_CODE" }, { status: 401 })]);
    await expect(client(fetch).verifyTotp({ cookie: "c=1" }, "000000")).rejects.toMatchObject({
      kind: "invalid_code",
    });
  });
});

describe("getMe and signOut", () => {
  it("sends the bearer token and validates the payload", async () => {
    const { fetch, calls } = fakeFetch([json(me)]);
    await expect(client(fetch).getMe("tok")).resolves.toEqual(me);
    expect(calls[0]?.url).toBe("https://api.example.invalid/v1/me");
    expect(headerOf(calls[0], "authorization")).toBe("Bearer tok");
    expect(headerOf(calls[0], "x-harbour-tenant")).toBeNull();
  });

  it("asks in the session's organisation when it knows it (security review round 4, H1)", async () => {
    const { fetch, calls } = fakeFetch([json(me)]);
    await client(fetch).getMe("tok", "00000000-0000-4000-8000-0000000000a1");
    expect(headerOf(calls[0], "x-harbour-tenant")).toBe("00000000-0000-4000-8000-0000000000a1");
  });

  it("treats 401 as an ended session", async () => {
    const { fetch } = fakeFetch([json({}, { status: 401 })]);
    await expect(client(fetch).getMe("tok")).rejects.toMatchObject({ kind: "session_expired" });
  });

  it("hazard HZ-006 treats a 403 as an ended session only with a session problem code (H1)", async () => {
    const session = fakeFetch([
      json({ code: "mfa_enrolment_required", title: "Set up MFA" }, { status: 403 }),
    ]);
    await expect(client(session.fetch).getMe("tok")).rejects.toMatchObject({
      kind: "session_expired",
    });
    const edge = fakeFetch([
      new Response("<html>Request blocked</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    ]);
    await expect(client(edge.fetch).getMe("tok")).rejects.toMatchObject({ kind: "server" });
    const unknown = fakeFetch([json({ code: "edge_blocked" }, { status: 403 })]);
    await expect(client(unknown.fetch).getMe("tok")).rejects.toMatchObject({ kind: "server" });
  });

  it("never throws from signOut, even offline", async () => {
    const { fetch } = fakeFetch([new TypeError("offline")]);
    await expect(client(fetch).signOut("tok")).resolves.toBeUndefined();
  });
});

describe("parseMe", () => {
  it("keeps the tenant_user id, which owns the entries written on this device", () => {
    expect(parseMe(me).tenantUserId).toBe("tu-1");
    expect(parseMe({ ...me, tenantUserId: undefined }).tenantUserId).toBeNull();
  });

  it.each([
    null,
    {},
    { ...me, user: { id: 1, name: "x" } },
    { ...me, locations: [{ id: "l" }] },
    { ...me, permissions: [1] },
  ])("rejects %j", (value) => {
    expect(() => parseMe(value)).toThrow(AuthError);
  });
});

describe("normaliseTotpCode", () => {
  it.each([
    ["123456", "123456"],
    [" 123 456 ", "123456"],
    ["12345", null],
    ["1234567", null],
    ["12a456", null],
  ])("%s -> %s", (input, expected) => {
    expect(normaliseTotpCode(input)).toBe(expected);
  });
});
