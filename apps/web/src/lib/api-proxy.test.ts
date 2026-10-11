import { describe, expect, it } from "vitest";
import { forwardRequestHeaders, forwardResponseHeaders, upstreamUrl } from "./api-proxy";

describe("forwardRequestHeaders", () => {
  const incoming = new Headers({
    cookie: "harbour.session_token=abc",
    origin: "https://app.example.invalid",
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0",
    "x-forwarded-for": "192.0.2.10, 198.51.100.4",
    host: "app.example.invalid",
    connection: "keep-alive",
    "content-length": "42",
    "accept-encoding": "gzip, br",
    "transfer-encoding": "chunked",
    rsc: "1",
    "next-router-state-tree": "%5B%5D",
    "x-middleware-subrequest": "proxy",
    "x-middleware-next": "1",
  });

  it.each(["cookie", "origin", "content-type", "user-agent", "x-forwarded-for"])(
    "keeps %s, which Better Auth needs",
    (name) => {
      expect(forwardRequestHeaders(incoming).get(name)).toBe(incoming.get(name));
    },
  );

  it.each([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "transfer-encoding",
    "rsc",
    "next-router-state-tree",
    "x-middleware-subrequest",
    "x-middleware-next",
  ])("drops %s", (name) => {
    expect(forwardRequestHeaders(incoming).has(name)).toBe(false);
  });
});

describe("forwardResponseHeaders", () => {
  it("keeps every cookie separate and never lets the response be cached", () => {
    const upstream = new Headers();
    upstream.append("set-cookie", "harbour.session_token=abc; Path=/; HttpOnly; SameSite=Lax");
    upstream.append("set-cookie", "harbour.session_data=def; Path=/; HttpOnly; SameSite=Lax");
    upstream.set("content-type", "application/json");
    upstream.set("content-encoding", "gzip");
    upstream.set("content-length", "10");
    upstream.set("connection", "close");
    upstream.set("x-request-id", "req-1");

    const out = forwardResponseHeaders(upstream);
    expect(out.getSetCookie()).toEqual([
      "harbour.session_token=abc; Path=/; HttpOnly; SameSite=Lax",
      "harbour.session_data=def; Path=/; HttpOnly; SameSite=Lax",
    ]);
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("x-request-id")).toBe("req-1");
    expect(out.get("cache-control")).toBe("no-store");
    for (const name of ["content-encoding", "content-length", "connection"]) {
      expect(out.has(name)).toBe(false);
    }
  });
});

describe("upstreamUrl", () => {
  it.each([
    ["http://localhost:3000/api/auth/get-session", "http://localhost:4000/api/auth/get-session"],
    [
      "https://app.example.invalid/api/auth/passkey/generate-authenticate-options?a=1",
      "http://localhost:4000/api/auth/passkey/generate-authenticate-options?a=1",
    ],
  ])("maps %s", (from, to) => {
    expect(upstreamUrl("http://localhost:4000", from)).toBe(to);
  });
});
