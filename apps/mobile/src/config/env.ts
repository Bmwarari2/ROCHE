/**
 * Build-time configuration. `EXPO_PUBLIC_*` values are inlined into the bundle, so nothing here is
 * secret. Parsing is pure so it can be unit-tested; `app-env.ts` reads the real values.
 */

export const DEFAULT_API_URL = "http://localhost:4000";

export interface AppEnv {
  /** API base URL without a trailing slash. */
  readonly apiUrl: string;
  /** Seed the local database with invented people and never contact the API. */
  readonly demoMode: boolean;
}

export interface RawEnv {
  readonly EXPO_PUBLIC_API_URL?: string | undefined;
  readonly EXPO_PUBLIC_DEMO_MODE?: string | undefined;
  /**
   * End-to-end builds only (`.github/workflows/mobile.yml`): allow plain http to the phone's own
   * loopback (`localhost`, `127.0.0.1`), which `adb reverse` forwards to the CI runner's API and
   * PowerSync. Nothing reaches the network over http: on a real phone loopback is the phone itself.
   * Never set in an EAS profile (`eas-profiles.test.ts`).
   */
  readonly EXPO_PUBLIC_E2E_LOOPBACK?: string | undefined;
}

export interface ParseEnvOptions {
  /** Allow plain http to development hosts (true only in development builds). */
  readonly allowInsecure: boolean;
}

const DEVELOPMENT_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2", "[::1]"]);
/** The phone's own loopback: never a network address, so safe for an end-to-end build. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function isTruthyFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Validates the API URL. Release builds require https (TLS 1.2+, section 5.3); plain http is only
 * accepted for local development hosts in development builds, and for the phone's own loopback in an
 * end-to-end build, because the session token travels in the Authorization header.
 */
export function parseEnv(raw: RawEnv, options: ParseEnvOptions): AppEnv {
  const demoMode = isTruthyFlag(raw.EXPO_PUBLIC_DEMO_MODE);
  const value = (raw.EXPO_PUBLIC_API_URL ?? "").trim() || DEFAULT_API_URL;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`EXPO_PUBLIC_API_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("EXPO_PUBLIC_API_URL must use https");
  }
  if (url.protocol === "http:") {
    const developmentHost = DEVELOPMENT_HOSTS.has(url.hostname) || url.hostname.endsWith(".local");
    const e2eLoopback =
      isTruthyFlag(raw.EXPO_PUBLIC_E2E_LOOPBACK) && LOOPBACK_HOSTS.has(url.hostname);
    if (!(options.allowInsecure && developmentHost) && !e2eLoopback && !demoMode) {
      throw new Error("EXPO_PUBLIC_API_URL must use https outside local development");
    }
  }

  const apiUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return { apiUrl, demoMode };
}
