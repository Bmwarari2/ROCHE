import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, createNonce } from "./csp";

describe("contentSecurityPolicy", () => {
  it("allows scripts only with the request's nonce in production", () => {
    const policy = contentSecurityPolicy("abc123", false);
    expect(policy).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("adds eval and the dev-server socket only in development", () => {
    const policy = contentSecurityPolicy("abc123", true);
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self' ws: wss:");
  });

  it.each([
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "default-src 'self'",
  ])("keeps %s", (directive) => {
    expect(contentSecurityPolicy("n", false)).toContain(directive);
  });
});

describe("createNonce", () => {
  it("is base64 of 16 random bytes and differs every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    }
  });
});
