import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const PRODUCTION = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "a-deployed-secret-that-is-long-enough-0123456789",
  SYNC_SIGNING_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----",
  DATABASE_APP_URL: "postgres://harbour_app@db.internal/harbour",
  DATABASE_AUTH_URL: "postgres://harbour_auth@db.internal/harbour",
  DATABASE_OPERATOR_URL: "postgres://harbour_operator@db.internal/harbour",
  DATABASE_WORKER_URL: "postgres://harbour_worker@db.internal/harbour",
} as const;

describe("loadConfig", () => {
  it("starts in production when every secret is present", () => {
    expect(loadConfig({ ...PRODUCTION }).NODE_ENV).toBe("production");
  });

  it.each([
    "BETTER_AUTH_SECRET",
    "SYNC_SIGNING_KEY_PEM",
    "DATABASE_APP_URL",
    "DATABASE_AUTH_URL",
    "DATABASE_OPERATOR_URL",
    "DATABASE_WORKER_URL",
  ])("refuses to start in production without %s", (key) => {
    const env: Record<string, string> = { ...PRODUCTION };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it("uses local defaults outside production", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.DATABASE_OPERATOR_URL).toContain("localhost");
    expect(config.trustedProxies).toEqual([]);
  });

  it("splits comma-separated origins and proxy ranges", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      WEB_ORIGINS: "https://app.example.invalid, https://admin.example.invalid",
      TRUSTED_PROXY_CIDRS: "10.20.0.0/16, ,192.0.2.0/24",
    });
    expect(config.webOrigins).toEqual([
      "https://app.example.invalid",
      "https://admin.example.invalid",
    ]);
    expect(config.trustedProxies).toEqual(["10.20.0.0/16", "192.0.2.0/24"]);
  });
});
