import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const PRODUCTION = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "a-deployed-secret-that-is-long-enough-0123456789",
  EVIDENCE_LINK_SECRET: "a-deployed-evidence-link-key-long-enough-0123456789",
  SYNC_SIGNING_KEY_PEM: "-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----",
  DATABASE_APP_URL: "postgres://harbour_app@db.internal/harbour",
  DATABASE_AUTH_URL: "postgres://harbour_auth@db.internal/harbour",
  DATABASE_OPERATOR_URL: "postgres://harbour_operator@db.internal/harbour",
  DATABASE_WORKER_URL: "postgres://harbour_worker@db.internal/harbour",
  DOCUMENT_STORAGE: "gcs",
  GCP_PROJECT_ID: "harbour-dev",
  GCS_DOCUMENTS_BUCKET: "harbour-dev-documents",
  GCS_EXPORTS_BUCKET: "harbour-dev-exports",
  GCS_KMS_KEY: "projects/harbour-dev/locations/europe-west2/keyRings/harbour/cryptoKeys/storage",
  MALWARE_SCANNER: "clamd",
  SAFETY_CASE_VERSION: "v0.0",
  TENANT_KEY_PROVIDER: "cloudkms",
  DATABASE_PITR_DAYS: "7",
  DATABASE_BACKUP_RETENTION_DAYS: "30",
  TENANT_KMS_KEY_RING: "projects/harbour-dev/locations/europe-west2/keyRings/harbour-dev-tenants",
  CERTIFICATE_SIGNING_KEY:
    "projects/harbour-dev/locations/europe-west2/keyRings/harbour-dev-certificates/cryptoKeys/certificate-signing/cryptoKeyVersions/1",
} as const;

describe("loadConfig", () => {
  it("starts in production when every secret is present", () => {
    expect(loadConfig({ ...PRODUCTION }).NODE_ENV).toBe("production");
  });

  it.each([
    "BETTER_AUTH_SECRET",
    "EVIDENCE_LINK_SECRET",
    "SYNC_SIGNING_KEY_PEM",
    "DATABASE_APP_URL",
    "DATABASE_AUTH_URL",
    "DATABASE_OPERATOR_URL",
    "DATABASE_WORKER_URL",
    "GCP_PROJECT_ID",
    "GCS_DOCUMENTS_BUCKET",
    "GCS_EXPORTS_BUCKET",
    "GCS_KMS_KEY",
    "SAFETY_CASE_VERSION",
    "TENANT_KMS_KEY_RING",
    "CERTIFICATE_SIGNING_KEY",
    "DATABASE_PITR_DAYS",
    "DATABASE_BACKUP_RETENTION_DAYS",
  ])("refuses to start in production without %s", (key) => {
    const env: Record<string, string> = { ...PRODUCTION };
    delete env[key];
    expect(() => loadConfig(env)).toThrow(key);
  });

  it.each([
    ["local document storage", { DOCUMENT_STORAGE: "local" }, "DOCUMENT_STORAGE"],
    ["the mock malware scanner", { MALWARE_SCANNER: "mock" }, "MALWARE_SCANNER"],
    ["local organisation keys", { TENANT_KEY_PROVIDER: "local" }, "TENANT_KEY_PROVIDER"],
    [
      "reading objects stored unencrypted",
      { DOCUMENTS_LEGACY_PLAINTEXT: "on" },
      "DOCUMENTS_LEGACY_PLAINTEXT",
    ],
    [
      "one bucket for documents and exports",
      { GCS_EXPORTS_BUCKET: "harbour-dev-documents" },
      "GCS_EXPORTS_BUCKET",
    ],
    ["SMTP without TLS", { SMTP_HOST: "smtp.example.invalid", SMTP_TLS: "none" }, "SMTP_TLS"],
    ["SMTP to a local catcher", { SMTP_HOST: "localhost" }, "SMTP_HOST"],
    [
      "an SMTP user without a password",
      { SMTP_HOST: "smtp.example.invalid", SMTP_USER: "harbour" },
      "SMTP_PASSWORD",
    ],
    ["the browser idle timeout (HZ-111)", { SESSION_IDLE_TIMEOUT: "on" }, "SESSION_IDLE_TIMEOUT"],
    [
      "more than 10 sign-ins a minute",
      { AUTH_SIGN_IN_PER_MINUTE: "11" },
      "AUTH_SIGN_IN_PER_MINUTE",
    ],
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
    expect(config.AUTH_SIGN_IN_PER_MINUTE).toBe(10);
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

describe("SAFETY_CASE_VERSION", () => {
  it("names a safety case report that exists, by default", () => {
    const dir = fileURLToPath(
      new URL("../../../docs/clinical-safety/safety-case/", import.meta.url),
    );
    const version = loadConfig({}).SAFETY_CASE_VERSION;
    expect(readdirSync(dir).some((f) => f.startsWith(`safety-case-${version}-`))).toBe(true);
  });
});

describe("Google Cloud and SMTP settings (ADR-0098)", () => {
  it.each([
    [
      "a key in another region",
      "projects/harbour-dev/locations/europe-west1/keyRings/h/cryptoKeys/s",
    ],
    ["a global key", "projects/harbour-dev/locations/global/keyRings/h/cryptoKeys/s"],
    [
      "a key version",
      "projects/harbour-dev/locations/europe-west2/keyRings/h/cryptoKeys/s/cryptoKeyVersions/1",
    ],
    ["an AWS key", "arn:aws:kms:eu-west-2:111122223333:key/abcd"],
  ])("refuses %s for the buckets", (_label, key) => {
    expect(() => loadConfig({ ...PRODUCTION, GCS_KMS_KEY: key })).toThrow();
  });

  it("starts in production with email off when no SMTP relay is named", () => {
    expect(loadConfig({ ...PRODUCTION }).smtp).toBeNull();
  });

  it("sends through the named relay over STARTTLS in production", () => {
    const config = loadConfig({
      ...PRODUCTION,
      SMTP_HOST: "smtp.example.invalid",
      SMTP_USER: "harbour",
      SMTP_PASSWORD: "a-relay-password",
    });
    expect(config.smtp).toEqual({
      host: "smtp.example.invalid",
      port: 587,
      tls: "starttls",
      user: "harbour",
      password: "a-relay-password",
    });
  });

  it("uses Mailpit outside production", () => {
    expect(loadConfig({ NODE_ENV: "development" }).smtp).toEqual({
      host: "127.0.0.1",
      port: 1025,
      tls: "none",
    });
  });
});
