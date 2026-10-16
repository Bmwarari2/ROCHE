import { z } from "zod";

/**
 * API configuration from the environment. Secrets come from AWS Secrets Manager in deployed
 * environments (injected as environment variables by ECS) and from `.env` locally; never from Git.
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  /** harbour_app: tenant data, subject to row-level security. */
  DATABASE_APP_URL: z
    .string()
    .default("postgres://harbour_app:harbour_app_local@localhost:5432/harbour"),
  /** harbour_auth: the Better Auth schema only. */
  DATABASE_AUTH_URL: z
    .string()
    .default("postgres://harbour_auth:harbour_auth_local@localhost:5432/harbour"),
  /** harbour_operator: the Thapsus operator console (provisioning and health only). */
  DATABASE_OPERATOR_URL: z
    .string()
    .default("postgres://harbour_operator:harbour_operator_local@localhost:5432/harbour"),
  /** harbour_worker: outbox relay and escalation scheduler. */
  DATABASE_WORKER_URL: z
    .string()
    .default("postgres://harbour_worker:harbour_worker_local@localhost:5432/harbour"),
  BETTER_AUTH_SECRET: z.string().min(32).default("local-development-secret-change-me-0123456789"),
  BETTER_AUTH_URL: z.url().default("http://localhost:4000"),
  /** Comma-separated origins allowed to call the API with credentials (the web app). */
  WEB_ORIGINS: z.string().default("http://localhost:3000"),
  PASSKEY_RP_ID: z.string().default("localhost"),
  /**
   * Comma-separated CIDRs of the load balancers and the web tier in front of the API. Sign-in
   * throttling reads the client address from X-Forwarded-For, skipping these hops from the right;
   * without them every sign-in shares one throttle bucket.
   */
  TRUSTED_PROXY_CIDRS: z.string().default(""),
  /**
   * Sign-in attempts allowed per client address per minute. The end-to-end run raises it: its
   * servers sit behind no proxy, so every journey's sign-in shares one address. Never above 10 in
   * production.
   */
  AUTH_SIGN_IN_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  POWERSYNC_URL: z.url().default("http://localhost:8080"),
  /** PKCS#8 PEM for the ES256 key that signs PowerSync tokens; generated per process when absent locally. */
  SYNC_SIGNING_KEY_PEM: z.string().optional(),
  SYNC_SIGNING_KEY_ID: z.string().default("harbour-sync-1"),
  /** Seconds a sign-in counts as fresh for step-up actions (section 5.3). */
  STEP_UP_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  /** Transfer pack previews, creations and prints per user a minute, per API instance (S2). */
  TRANSFER_PACK_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(30),
  /**
   * Handover compilations asked for through the API per user a minute, per API instance: each
   * reads a shift's records at a location (the worker compiles every handover anyway).
   */
  HANDOVER_COMPILE_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(12),
  /**
   * Invitation links opened or accepted (no one signed in yet), per minute per API instance: per
   * client address, and per token (counted by its SHA-256).
   */
  INVITATION_REQUESTS_PER_MINUTE_PER_ADDRESS: z.coerce.number().int().positive().default(20),
  INVITATION_REQUESTS_PER_MINUTE_PER_TOKEN: z.coerce.number().int().positive().default(10),
  /**
   * The server key for evidence pack links (ADR-0050): one-time codes are stored as an HMAC under
   * it, and the link session cookie is signed with it. From Secrets Manager in deployed
   * environments; the local default is refused in production.
   */
  EVIDENCE_LINK_SECRET: z
    .string()
    .min(32)
    .default("local-development-evidence-link-secret-0123456789"),
  /** Evidence pack link requests (codes, verification, opens) per minute per API instance. */
  EVIDENCE_LINK_REQUESTS_PER_MINUTE_PER_ADDRESS: z.coerce.number().int().positive().default(20),
  EVIDENCE_LINK_REQUESTS_PER_MINUTE_PER_LINK: z.coerce.number().int().positive().default(10),
  /** How long a verified link session lasts in the browser (never past the link's own expiry). */
  EVIDENCE_LINK_SESSION_MINUTES: z.coerce.number().int().positive().max(240).default(60),
  /** Where document bytes live: local disk (development and tests) or S3 (AWS). */
  DOCUMENT_STORAGE: z.enum(["local", "s3"]).default("local"),
  LOCAL_DOCUMENTS_DIR: z.string().default(".data/documents"),
  S3_DOCUMENTS_BUCKET: z.string().optional(),
  /** Malware scanning of uploads: ClamAV (AWS), the EICAR-aware mock (tests), or none (quarantine all). */
  MALWARE_SCANNER: z.enum(["clamd", "mock", "none"]).default("mock"),
  CLAMD_HOST: z.string().default("127.0.0.1"),
  CLAMD_PORT: z.coerce.number().int().default(3310),
  /**
   * Flagsmith (ADR-0001, H-13): optional, and off unless the environment's server-side key is set
   * (from Secrets Manager, never Git). Unreachable, every flag falls back to the catalogue default.
   */
  FLAGSMITH_API_URL: z.url().default("http://localhost:8000/api/v1"),
  FLAGSMITH_ENVIRONMENT_KEY: z.string().optional(),
  FLAGSMITH_TIMEOUT_MS: z.coerce.number().int().positive().default(500),
  FLAGSMITH_CACHE_SECONDS: z.coerce.number().int().positive().default(60),
  /**
   * The browser idle timeout (platform.md, Identity): off unless set to "on". Not to be turned on
   * until HZ-111's controls are built (a warning with "Stay signed in", and signing in again
   * without losing a form) and the CSO and DPO have decided (H-353); production refuses it.
   */
  SESSION_IDLE_TIMEOUT: z.enum(["off", "on"]).default("off"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_VERSION: z.string().default("0.0.0-dev"),
});

export type Config = z.infer<typeof Env> & {
  readonly webOrigins: readonly string[];
  readonly trustedProxies: readonly string[];
};

const DATABASE_URL_KEYS = [
  "DATABASE_APP_URL",
  "DATABASE_AUTH_URL",
  "DATABASE_OPERATOR_URL",
  "DATABASE_WORKER_URL",
] as const;

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * The environment's self-hosted Flagsmith host: `flags.<domain>` beside the API's `api.<domain>`
 * (infra/README.md), or null when the API is not served from an `api.` host.
 */
export function flagsmithHost(betterAuthUrl: string): string | null {
  const host = new URL(betterAuthUrl).hostname;
  return host.startsWith("api.") ? `flags.${host.slice("api.".length)}` : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  if (parsed.NODE_ENV === "production") {
    if (parsed.BETTER_AUTH_SECRET.startsWith("local-development")) {
      throw new Error("BETTER_AUTH_SECRET must be set in production");
    }
    if (parsed.EVIDENCE_LINK_SECRET.startsWith("local-development")) {
      throw new Error("EVIDENCE_LINK_SECRET must be set in production");
    }
    if (!parsed.SYNC_SIGNING_KEY_PEM)
      throw new Error("SYNC_SIGNING_KEY_PEM must be set in production");
    // The local defaults point at localhost; a deployed task without its secret must not start.
    for (const key of DATABASE_URL_KEYS) {
      if (!env[key]) throw new Error(`${key} must be set in production`);
    }
    if (parsed.DOCUMENT_STORAGE !== "s3" || !parsed.S3_DOCUMENTS_BUCKET) {
      throw new Error("DOCUMENT_STORAGE must be s3 with S3_DOCUMENTS_BUCKET set in production");
    }
    if (parsed.AUTH_SIGN_IN_PER_MINUTE > 10) {
      throw new Error("AUTH_SIGN_IN_PER_MINUTE cannot be above 10 in production");
    }
    if (parsed.MALWARE_SCANNER === "mock") {
      throw new Error("MALWARE_SCANNER cannot be mock in production");
    }
    // Signing a browser out mid-entry loses the form (HZ-111): off until its controls exist.
    if (parsed.SESSION_IDLE_TIMEOUT === "on") {
      throw new Error("SESSION_IDLE_TIMEOUT cannot be on in production until HZ-111 is controlled");
    }
    // Flagsmith only at the environment's own self-hosted host, over TLS (#39 review L2).
    if (parsed.FLAGSMITH_ENVIRONMENT_KEY) {
      const expected = flagsmithHost(parsed.BETTER_AUTH_URL);
      const url = env.FLAGSMITH_API_URL ? new URL(parsed.FLAGSMITH_API_URL) : null;
      if (!url || !expected || url.protocol !== "https:" || url.hostname !== expected) {
        throw new Error(
          "FLAGSMITH_API_URL must be https on the environment's own flags host (flags.<domain>) in production",
        );
      }
    }
  }
  return {
    ...parsed,
    webOrigins: list(parsed.WEB_ORIGINS),
    trustedProxies: list(parsed.TRUSTED_PROXY_CIDRS),
  };
}
