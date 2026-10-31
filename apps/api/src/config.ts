import { z } from "zod";

/**
 * API configuration from the environment. Secrets come from Google Cloud Secret Manager in deployed
 * environments (injected as environment variables by the platform, ADR-0098) and from `.env`
 * locally; never from Git.
 */

/** The only Google Cloud region personal data may live in (ADR-0098). */
export const GCP_REGIONS = ["europe-west2"] as const;

const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** A Cloud KMS key in an allowed region: projects/<p>/locations/<region>/keyRings/<r>/cryptoKeys/<k>. */
const KMS_KEY = new RegExp(
  `^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/(${GCP_REGIONS.join("|")})/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63}$`,
);
/** A key ring in an allowed region: projects/<p>/locations/<region>/keyRings/<r>. */
const KMS_KEY_RING = new RegExp(
  `^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/(${GCP_REGIONS.join("|")})/keyRings/[A-Za-z0-9_-]{1,63}$`,
);
/** An asymmetric key version in an allowed region (the certificate signing key). */
const KMS_KEY_VERSION = new RegExp(
  `^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/(${GCP_REGIONS.join("|")})/keyRings/[A-Za-z0-9_-]{1,63}/cryptoKeys/[A-Za-z0-9_-]{1,63}/cryptoKeyVersions/[0-9]{1,10}$`,
);
/** Bucket names as Cloud Storage takes them (no dotted, domain-named buckets). */
const BUCKET = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;

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
  /**
   * Harbour's clinical safety case for the release this API runs (docs/clinical-safety/
   * safety-case/), which an organisation's DCB0160 assessment must cover to go live. Production
   * must name it (the release pipeline sets it from the report signed for the release); the API
   * image carries no docs, so a test checks the named report exists rather than the server.
   */
  SAFETY_CASE_VERSION: z.string().trim().min(1).max(40).default("v0.0"),
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
   * Account deletion requests a member may send in 24 hours (MOB-011): each new one raises a task
   * and an email for a manager, so a member cannot flood them. A product setting, not a statutory
   * figure.
   */
  ACCOUNT_DELETION_REQUESTS_PER_DAY: z.coerce.number().int().positive().default(3),
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
  /** Where document bytes live: local disk (development and tests) or Cloud Storage (Google Cloud). */
  DOCUMENT_STORAGE: z.enum(["local", "gcs"]).default("local"),
  LOCAL_DOCUMENTS_DIR: z.string().default(".data/documents"),
  /** The Google Cloud project the buckets belong to. Credentials come from the runtime's identity. */
  GCP_PROJECT_ID: z.string().regex(GCP_PROJECT).optional(),
  GCS_DOCUMENTS_BUCKET: z.string().regex(BUCKET).optional(),
  /** The full export's archives (PLAT-015): the exports bucket (CMEK, lifecycle expiry). */
  LOCAL_EXPORTS_DIR: z.string().default(".data/exports"),
  GCS_EXPORTS_BUCKET: z.string().regex(BUCKET).optional(),
  /** The customer-managed Cloud KMS key both buckets encrypt with, in europe-west2. */
  GCS_KMS_KEY: z.string().regex(KMS_KEY).optional(),
  /**
   * Organisation keys for envelope encryption and crypto-shredding (ADR-0109): Cloud KMS in
   * production (one key per organisation in TENANT_KMS_KEY_RING), local files in development and
   * an in-memory provider in tests. CERTIFICATE_SIGNING_KEY signs destruction certificates.
   */
  TENANT_KEY_PROVIDER: z.enum(["local", "cloudkms"]).default("local"),
  TENANT_KMS_KEY_RING: z.string().regex(KMS_KEY_RING).optional(),
  CERTIFICATE_SIGNING_KEY: z.string().regex(KMS_KEY_VERSION).optional(),
  /** Local keys (development): `.data/keys` when unset; tests keep keys in memory. */
  LOCAL_KEYS_DIR: z.string().optional(),
  /**
   * Objects stored before envelope encryption are read as they are only when this is `on`, which
   * production refuses (H-1115). Off by default, so a deployed environment never serves them.
   */
  DOCUMENTS_LEGACY_PLAINTEXT: z.enum(["on", "off"]).default("off"),
  /**
   * The database's point-in-time recovery window and its longest backup retention, in days:
   * certificates state that backups no longer hold deleted rows after the longer of the two.
   * Both are required in production (H-1114); elsewhere each counts as 7.
   */
  DATABASE_PITR_DAYS: z.coerce.number().int().min(1).max(35).optional(),
  DATABASE_BACKUP_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).optional(),
  /**
   * The SMTP relay for email (the `smtp` provider of comms.email). Unset in production, email is not
   * configured and every send fails clearly; elsewhere it defaults to Mailpit (docker-compose.yml).
   * The password comes from Secret Manager, never Git.
   */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** implicit: TLS from the first byte (port 465); starttls: upgrade required; none: local only. */
  SMTP_TLS: z.enum(["implicit", "starttls", "none"]).optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** Malware scanning of uploads: ClamAV, the EICAR-aware mock (tests), or none (quarantine all). */
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
  /**
   * Whether the import wizard takes 999-range test NHS numbers and 0000000000 (platform.md rule
   * 20; #150 clinical review): "on" for demonstration and test environments, whose people are
   * invented; unset, it is off in production (real organisations) and on elsewhere.
   */
  IMPORT_TEST_NHS_NUMBERS: z.enum(["off", "on"]).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_VERSION: z.string().default("0.0.0-dev"),
});

/** The SMTP relay the `smtp` email provider sends through, or null when email is not configured. */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: "implicit" | "starttls" | "none";
  readonly user?: string;
  readonly password?: string;
}

export type Config = z.infer<typeof Env> & {
  readonly smtp: SmtpConfig | null;
  readonly webOrigins: readonly string[];
  readonly trustedProxies: readonly string[];
  /** `IMPORT_TEST_NHS_NUMBERS`, defaulted by environment: off in production unless set. */
  readonly importTestNhsNumbers: boolean;
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
    // A live organisation's DCB0160 assessment must cover the release it runs (HZ-014 and the
    // clinical risk management plan section 7), so the local default is never assumed.
    if (!env.SAFETY_CASE_VERSION) throw new Error("SAFETY_CASE_VERSION must be set in production");
    // The local defaults point at localhost; a deployed task without its secret must not start.
    for (const key of DATABASE_URL_KEYS) {
      if (!env[key]) throw new Error(`${key} must be set in production`);
    }
    if (parsed.DOCUMENT_STORAGE !== "gcs") {
      throw new Error("DOCUMENT_STORAGE must be gcs in production");
    }
    for (const key of [
      "GCP_PROJECT_ID",
      "GCS_DOCUMENTS_BUCKET",
      "GCS_EXPORTS_BUCKET",
      "GCS_KMS_KEY",
    ] as const) {
      if (!parsed[key]) throw new Error(`${key} must be set in production`);
    }
    if (parsed.TENANT_KEY_PROVIDER !== "cloudkms") {
      throw new Error("TENANT_KEY_PROVIDER must be cloudkms in production");
    }
    for (const key of [
      "TENANT_KMS_KEY_RING",
      "CERTIFICATE_SIGNING_KEY",
      "DATABASE_PITR_DAYS",
      "DATABASE_BACKUP_RETENTION_DAYS",
    ] as const) {
      if (parsed[key] === undefined) throw new Error(`${key} must be set in production`);
    }
    if (parsed.DOCUMENTS_LEGACY_PLAINTEXT === "on") {
      throw new Error("DOCUMENTS_LEGACY_PLAINTEXT cannot be on in production");
    }
    if (parsed.GCS_DOCUMENTS_BUCKET === parsed.GCS_EXPORTS_BUCKET) {
      throw new Error("GCS_EXPORTS_BUCKET must not be the documents bucket in production");
    }
    // Email stays off until a provider is chosen; once a relay is named it must be a real one, over TLS.
    if (parsed.SMTP_HOST) {
      if ((parsed.SMTP_TLS ?? "starttls") === "none") {
        throw new Error("SMTP_TLS cannot be none in production");
      }
      if (/^(localhost|127\.|::1$|\[::1\]$)/i.test(parsed.SMTP_HOST)) {
        throw new Error("SMTP_HOST cannot be a local catcher in production");
      }
      if (Boolean(parsed.SMTP_USER) !== Boolean(parsed.SMTP_PASSWORD)) {
        throw new Error("SMTP_USER and SMTP_PASSWORD must be set together in production");
      }
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
    smtp: smtpConfig(parsed),
    webOrigins: list(parsed.WEB_ORIGINS),
    trustedProxies: list(parsed.TRUSTED_PROXY_CIDRS),
    importTestNhsNumbers:
      (parsed.IMPORT_TEST_NHS_NUMBERS ?? (parsed.NODE_ENV === "production" ? "off" : "on")) ===
      "on",
  };
}

/** Production sends only through a named relay; elsewhere Mailpit on its default port. */
function smtpConfig(parsed: z.infer<typeof Env>): SmtpConfig | null {
  if (parsed.NODE_ENV === "production" && !parsed.SMTP_HOST) return null;
  const tls = parsed.SMTP_TLS ?? (parsed.SMTP_HOST ? "starttls" : "none");
  return {
    host: parsed.SMTP_HOST ?? "127.0.0.1",
    port: parsed.SMTP_PORT ?? (tls === "implicit" ? 465 : parsed.SMTP_HOST ? 587 : 1025),
    tls,
    ...(parsed.SMTP_USER ? { user: parsed.SMTP_USER } : {}),
    ...(parsed.SMTP_PASSWORD ? { password: parsed.SMTP_PASSWORD } : {}),
  };
}
