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
  DOCUMENT_STORAGE: "s3",
  S3_DOCUMENTS_BUCKET: "harbour-dev-documents",
  MALWARE_SCANNER: "clamd",
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
    "S3_DOCUMENTS_BUCKET",
  ])("refuses to start in production without %s", (key) => {
    const env: Record<string, string> = { ...PRODUCTION };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it.each([
    ["local document storage", { DOCUMENT_STORAGE: "local" }, "DOCUMENT_STORAGE"],
    ["the mock malware scanner", { MALWARE_SCANNER: "mock" }, "MALWARE_SCANNER"],
    [
      "a Flagsmith key with no address",
      { FLAGSMITH_ENVIRONMENT_KEY: "ser.x" },
      "FLAGSMITH_API_URL",
    ],
  ])("refuses %s in production", (_label, change, message) => {
    expect(() => loadConfig({ ...PRODUCTION, ...change })).toThrow(message);
  });

  // #39 review L2: Flagsmith only over TLS at the environment's own flags host.
  const FLAGSMITH = {
    BETTER_AUTH_URL: "https://api.harbour.example.invalid",
    FLAGSMITH_ENVIRONMENT_KEY: "ser.test-only",
  };
  it.each([
    ["plain http", "http://flags.harbour.example.invalid/api/v1"],
    ["another host", "https://flags.elsewhere.example.invalid/api/v1"],
    ["a look-alike host", "https://flags.harbour.example.invalid.evil.example/api/v1"],
  ])("refuses a Flagsmith address over %s in production", (_label, address) => {
    expect(() => loadConfig({ ...PRODUCTION, ...FLAGSMITH, FLAGSMITH_API_URL: address })).toThrow(
      "FLAGSMITH_API_URL",
    );
  });

  it("takes the environment's own Flagsmith host over https in production", () => {
    const config = loadConfig({
      ...PRODUCTION,
      ...FLAGSMITH,
      FLAGSMITH_API_URL: "https://flags.harbour.example.invalid/api/v1",
    });
    expect(config.FLAGSMITH_API_URL).toBe("https://flags.harbour.example.invalid/api/v1");
    // An API not served from an api. host has no flags host to trust.
    expect(() =>
      loadConfig({
        ...PRODUCTION,
        FLAGSMITH_ENVIRONMENT_KEY: "ser.test-only",
        FLAGSMITH_API_URL: "https://flags.localhost/api/v1",
      }),
    ).toThrow("FLAGSMITH_API_URL");
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
