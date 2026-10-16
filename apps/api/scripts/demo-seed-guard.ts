/**
 * Where the demo seed's test-only switches may run (#63 security review of 13f170b).
 *
 * `HARBOUR_DEMO_E2E_PASSKEY=1` gives manager@example.invalid a passkey whose private key anyone can
 * derive from a published phrase, and that passkey passes MFA and step-up (break-glass, statutory
 * notifications, export). `HARBOUR_DEMO_MFA=off` lets every demo user open care records with a
 * password alone. Both are for a throwaway local or CI database only: never dev, staging or a
 * pilot (Supabase London, ADR-0008), whatever NODE_ENV says.
 */

/** The switches this guard covers, as they appear in the environment. */
export const TEST_ONLY_SWITCHES = ["HARBOUR_DEMO_E2E_PASSKEY", "HARBOUR_DEMO_MFA"] as const;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** The Postgres service container's host name in CI (GitHub Actions service networking). */
const CI_SERVICE_HOST = "postgres";
const SHARED_ENVIRONMENTS = new Set(["dev", "staging", "pilot", "production", "prod"]);

/** Whether any test-only switch is turned on. */
export function wantsTestOnlySwitch(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.HARBOUR_DEMO_E2E_PASSKEY === "1" || env.HARBOUR_DEMO_MFA === "off";
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why the test-only switches may not run here, or null when they may. Checks the environment
 * name, NODE_ENV and that every database URL the seed writes through points at this machine (or
 * the CI service container when CI is set).
 */
export function testOnlySwitchRefusal(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeEnv: string;
  readonly databaseUrls: readonly string[];
}): string | null {
  const harbourEnv = input.env.HARBOUR_ENV?.trim().toLowerCase();
  if (harbourEnv && SHARED_ENVIRONMENTS.has(harbourEnv)) {
    return `HARBOUR_ENV is ${harbourEnv}: the test-only demo switches never run on a shared environment`;
  }
  if (input.nodeEnv !== "test" && input.nodeEnv !== "development") {
    return `NODE_ENV is ${input.nodeEnv}: the test-only demo switches need test or development`;
  }
  for (const url of input.databaseUrls) {
    const host = hostOf(url);
    const allowed =
      host !== null &&
      (LOCAL_HOSTS.has(host) || (input.env.CI === "true" && host === CI_SERVICE_HOST));
    if (!allowed) {
      return `A database URL points at ${host ?? "an unreadable host"}: the test-only demo switches need a local database`;
    }
  }
  return null;
}

/**
 * Why the switches may not change this database's demo users, or null when they may: the demo
 * manager must be linked in the demo tenant (`linkedTenantId` read from `tenant_user`).
 */
export function demoTenantRefusal(
  linkedTenantId: string | null,
  demoTenantId: string,
): string | null {
  if (linkedTenantId === demoTenantId) return null;
  return "The demo manager is not linked in the demo tenant: the test-only demo switches change nothing else";
}
