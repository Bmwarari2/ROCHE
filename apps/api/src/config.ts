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
  POWERSYNC_URL: z.url().default("http://localhost:8080"),
  /** PKCS#8 PEM for the ES256 key that signs PowerSync tokens; generated per process when absent locally. */
  SYNC_SIGNING_KEY_PEM: z.string().optional(),
  SYNC_SIGNING_KEY_ID: z.string().default("harbour-sync-1"),
  /** Seconds a sign-in counts as fresh for step-up actions (section 5.3). */
  STEP_UP_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_VERSION: z.string().default("0.0.0-dev"),
});

export type Config = z.infer<typeof Env> & { readonly webOrigins: readonly string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  if (parsed.NODE_ENV === "production") {
    if (parsed.BETTER_AUTH_SECRET.startsWith("local-development")) {
      throw new Error("BETTER_AUTH_SECRET must be set in production");
    }
    if (!parsed.SYNC_SIGNING_KEY_PEM)
      throw new Error("SYNC_SIGNING_KEY_PEM must be set in production");
  }
  return {
    ...parsed,
    webOrigins: parsed.WEB_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
