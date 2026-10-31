import { resolveTxt } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  fetchDiscoveryDocument,
  normalizeDiscoveryUrls,
  validateDiscoveryDocument,
} from "@better-auth/sso";
import { type Database, type Transaction, withRequestContext } from "@harbour/db";
import { ssoSignInDecision, tenantOfSsoProvider } from "@harbour/domain";
import { sql } from "drizzle-orm";
import type pg from "pg";
import type { Config } from "../config";
import type { Logger } from "../logger";

/**
 * Single sign-on plumbing (PLAT-005; platform.md, Phase 2: single sign-on, rules 18 to 22;
 * ADR-0091): the managed key store, the DNS proof lookup, the hooks the Better Auth SSO plugin
 * calls during a callback, and the plugin's provider row, which is a projection of the
 * organisation's `sso_connection` that only the API writes.
 */

/** Private keys by their store name. Never logs, stores or returns the key outside sign-in. */
export interface SsoKeyStore {
  has(ref: string): Promise<boolean>;
  get(ref: string): Promise<string | null>;
}

class AwsKeyStore implements SsoKeyStore {
  private readonly client = new SecretsManagerClient({});
  async get(ref: string): Promise<string | null> {
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: ref }));
      return out.SecretString ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === "ResourceNotFoundException") return null;
      throw error;
    }
  }
  /** Whether the key exists, without reading it (#33 review M3). */
  async has(ref: string): Promise<boolean> {
    try {
      await this.client.send(new DescribeSecretCommand({ SecretId: ref }));
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "ResourceNotFoundException") return false;
      throw error;
    }
  }
}

class MemoryKeyStore implements SsoKeyStore {
  constructor(private readonly keys: Readonly<Record<string, string>>) {}
  async get(ref: string) {
    return this.keys[ref] ?? null;
  }
  async has(ref: string) {
    return ref in this.keys;
  }
}

export function createSsoKeyStore(config: Config): SsoKeyStore {
  if (config.SSO_KEY_STORE === "aws") return new AwsKeyStore();
  return new MemoryKeyStore(JSON.parse(config.SSO_TEST_KEYS) as Record<string, string>);
}

/** The TXT records at a name; none when the name does not exist. */
export type TxtLookup = (name: string) => Promise<string[]>;

export function createTxtLookup(config: Config): TxtLookup {
  if (config.SSO_LOOKUPS === "mock") {
    const source = config.SSO_MOCK_TXT;
    return async (name) => {
      const text = source.trimStart().startsWith("{") ? source : await readFile(source, "utf8");
      return (JSON.parse(text) as Record<string, string[]>)[name] ?? [];
    };
  }
  return async (name) => {
    try {
      return (await resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch {
      return [];
    }
  };
}

interface SignInFacts extends Record<string, unknown> {
  tenant_id: string;
  enabled: boolean;
  allowed_role_keys: string[];
  verified_domains: string[];
  member_id: string | null;
  member_status: string | null;
  member_auth_user_id: string | null;
  member_role_keys: string[];
}

/** Runs a definer call in the provider's organisation, with no member (#33 review L1). */
function asProviderOrganisation<T>(
  db: Database,
  providerId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> | null {
  const tenantId = tenantOfSsoProvider(providerId);
  if (!tenantId) return null;
  return withRequestContext(db, { tenantId, userId: null, scope: "tenant", locationIds: [] }, fn);
}

async function signInFacts(
  db: Database,
  providerId: string,
  email: string,
): Promise<SignInFacts | null> {
  const result = await asProviderOrganisation(db, providerId, (tx) =>
    tx.execute<SignInFacts>(sql`SELECT * FROM app.sso_sign_in_facts(${providerId}, ${email})`),
  );
  return (result?.rows[0] as SignInFacts | undefined) ?? null;
}

/**
 * The Harbour sign-ins this identity provider account is already linked to: through this
 * provider, or through any provider with the same issuer (another organisation pointing at the
 * same identity provider), so one provider account belongs to one sign-in (#33 review H2).
 */
async function accountOwners(
  authPool: pg.Pool,
  providerId: string,
  accountKey: { issuer: string; accountId: string },
): Promise<string[]> {
  const { rows } = await authPool.query<{ user_id: string }>(
    `SELECT DISTINCT a.user_id FROM auth.account a
      WHERE a.account_id = $1
        AND (a.provider_id = $2 OR a.provider_id IN (
          SELECT p.provider_id FROM auth.sso_provider p WHERE p.issuer = $3))`,
    [accountKey.accountId, providerId, accountKey.issuer],
  );
  return rows.map((r) => r.user_id);
}

export type SsoResolution =
  | { action: "continue" }
  | { action: "link"; userId: string; profile: "preserve" }
  | { action: "reject"; code: string; message: string };

export interface SsoHooks {
  resolveUser(input: {
    providerId: string;
    accountKey: { issuer: string; accountId: string };
    providerUser: { email: string; emailVerified: boolean };
  }): Promise<SsoResolution>;
  /** No key (`{}`) makes the plugin refuse the sign-in. */
  resolvePrivateKey(input: { providerId: string }): Promise<{ privateKeyPem?: string }>;
  /** After Better Auth created a sign-in for an invited member: link it (rule 20). */
  linkInvitedMember(providerId: string, authUserId: string): Promise<void>;
}

const ACCOUNT_ELSEWHERE =
  "This identity provider account is already linked to another Harbour sign-in.";

/** The hooks the SSO plugin calls; they run before anyone is signed in. */
export function createSsoHooks(deps: {
  db: Database;
  authPool: pg.Pool;
  keys: SsoKeyStore;
  logger: Logger;
}): SsoHooks {
  const refuse = (tenantId: string | null, code: string, message: string): SsoResolution => {
    deps.logger.info({ event: "sso.sign_in_refused", tenantId, code }, "sso.sign_in_refused");
    return { action: "reject", code, message };
  };
  return {
    async resolveUser({ providerId, accountKey, providerUser }) {
      const facts = await signInFacts(deps.db, providerId, providerUser.email);
      if (!facts) return refuse(null, "sso_off", "Single sign-on is not set up.");
      const decision = ssoSignInDecision({
        ssoEnabled: facts.enabled,
        assertedEmail: providerUser.email,
        emailVerifiedByProvider: providerUser.emailVerified,
        verifiedDomains: facts.verified_domains,
        allowedRoleKeys: facts.allowed_role_keys,
        // Operators sign in to the operator console with their own sign-in; they are never
        // members, so a member row is what the check needs (rule 15).
        operator: false,
        member:
          facts.member_id && facts.member_status
            ? {
                // The definer matched the member by this address.
                email: providerUser.email,
                status: facts.member_status as "active" | "invited",
                kind: "staff",
                roleKeys: facts.member_role_keys,
              }
            : null,
      });
      if (!decision.ok) return refuse(facts.tenant_id, decision.problem, decision.message);
      const owners = await accountOwners(deps.authPool, providerId, accountKey);
      if (facts.member_auth_user_id) {
        // Only the member's own sign-in, and only if the account is not someone else's.
        if (owners.some((owner) => owner !== facts.member_auth_user_id))
          return refuse(facts.tenant_id, "sso_account_bound_elsewhere", ACCOUNT_ELSEWHERE);
        return { action: "link", userId: facts.member_auth_user_id, profile: "preserve" };
      }
      // An invited member with no sign-in yet: Better Auth creates one, then linkInvitedMember
      // links it; never when the provider account already belongs to a sign-in.
      if (owners.length > 0)
        return refuse(facts.tenant_id, "sso_account_bound_elsewhere", ACCOUNT_ELSEWHERE);
      return { action: "continue" };
    },
    async resolvePrivateKey({ providerId }) {
      const result = await asProviderOrganisation(deps.db, providerId, (tx) =>
        tx.execute<{ ref: string | null }>(sql`SELECT app.sso_key_ref(${providerId}) AS ref`),
      );
      const ref = (result?.rows[0] as { ref: string | null } | undefined)?.ref ?? null;
      const pem = ref ? await deps.keys.get(ref) : null;
      return pem ? { privateKeyPem: pem } : {};
    },
    async linkInvitedMember(providerId, authUserId) {
      try {
        await asProviderOrganisation(deps.db, providerId, (tx) =>
          tx.execute(sql`SELECT app.link_sso_member(${providerId}, ${authUserId})`),
        );
      } catch (error) {
        // An active member was linked by resolveUser instead; anything else leaves a sign-in with
        // no membership, which reaches nothing.
        const code = String((error as { cause?: { message?: string } }).cause?.message ?? "");
        if (!code.includes("already_member")) {
          deps.logger.warn(
            { event: "sso.link_failed", tenantId: tenantOfSsoProvider(providerId) },
            "sso.link_failed",
          );
        }
      }
    },
  };
}

export interface OidcEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksEndpoint: string;
  readonly userInfoEndpoint: string | null;
}

/**
 * Finds a provider's endpoints when the connection is saved (ADR-0091): the plugin's own discovery,
 * which refuses private hosts and redirects and checks the issuer, over https only. Tests use a
 * fixed set derived from the issuer.
 */
export type OidcDiscovery = (issuer: string, discoveryUrl: string) => Promise<OidcEndpoints>;

export function createOidcDiscovery(config: Config): OidcDiscovery {
  if (config.SSO_LOOKUPS === "mock") {
    return async (issuer) => ({
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      jwksEndpoint: `${issuer}/jwks`,
      userInfoEndpoint: `${issuer}/userinfo`,
    });
  }
  return discoverWithoutTrust;
}

/** Nothing is trusted: every fetch must reach a public host (no private, loopback or metadata). */
const NOTHING_TRUSTED = () => false;

/**
 * Discovery with the plugin's SSRF guards fully on (#33 review H1): the discovery URL, and every
 * endpoint it names, must be https on a publicly routable host that resolves to a public address,
 * with no redirects; the document's issuer must match. Fails with a generic error, never echoing
 * what the provider or the network said.
 */
export async function discoverWithoutTrust(
  issuer: string,
  discoveryUrl: string,
): Promise<OidcEndpoints> {
  const https = (url: string | undefined) => url?.startsWith("https://") === true;
  if (!https(issuer) || !https(discoveryUrl)) throw new Error("sso_discovery_failed");
  try {
    const document = await fetchDiscoveryDocument(discoveryUrl, undefined, NOTHING_TRUSTED);
    validateDiscoveryDocument(document, issuer);
    const doc = normalizeDiscoveryUrls(document, issuer, NOTHING_TRUSTED);
    const endpoints = {
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksEndpoint: doc.jwks_uri,
      userInfoEndpoint: doc.userinfo_endpoint ?? null,
    };
    if (
      ![endpoints.authorizationEndpoint, endpoints.tokenEndpoint, endpoints.jwksEndpoint].every(
        https,
      )
    )
      throw new Error("sso_discovery_failed");
    if (endpoints.userInfoEndpoint !== null && !https(endpoints.userInfoEndpoint))
      throw new Error("sso_discovery_failed");
    return endpoints;
  } catch {
    throw new Error("sso_discovery_failed");
  }
}

export interface SsoProviderProjection {
  readonly providerId: string;
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly privateKeyId: string | null;
  readonly endpoints: OidcEndpoints;
  readonly domain: string;
}

/**
 * Writes Better Auth's provider row from the organisation's connection (rule 18): OIDC with
 * `private_key_jwt` and PKCE, the endpoints found when it was saved, no secret. A connection
 * switched off has no row, so its sign-in cannot start.
 */
export async function upsertSsoProvider(authPool: pg.Pool, p: SsoProviderProjection) {
  const oidcConfig = JSON.stringify({
    issuer: p.issuer,
    clientId: p.clientId,
    discoveryEndpoint: p.discoveryUrl,
    authorizationEndpoint: p.endpoints.authorizationEndpoint,
    tokenEndpoint: p.endpoints.tokenEndpoint,
    jwksEndpoint: p.endpoints.jwksEndpoint,
    ...(p.endpoints.userInfoEndpoint ? { userInfoEndpoint: p.endpoints.userInfoEndpoint } : {}),
    tokenEndpointAuthentication: "private_key_jwt",
    ...(p.privateKeyId ? { privateKeyId: p.privateKeyId } : {}),
    pkce: true,
    scopes: ["openid", "email", "profile"],
  });
  await authPool.query(
    `INSERT INTO auth.sso_provider (id, issuer, oidc_config, provider_id, domain)
     VALUES ($1, $2, $3, $1, $4)
     ON CONFLICT (provider_id) DO UPDATE
       SET issuer = excluded.issuer, oidc_config = excluded.oidc_config, domain = excluded.domain`,
    [p.providerId, p.issuer, oidcConfig, p.domain],
  );
}

export async function removeSsoProvider(authPool: pg.Pool, providerId: string) {
  await authPool.query("DELETE FROM auth.sso_provider WHERE provider_id = $1", [providerId]);
}

export async function setSsoProviderDomain(authPool: pg.Pool, providerId: string, domain: string) {
  await authPool.query("UPDATE auth.sso_provider SET domain = $2 WHERE provider_id = $1", [
    providerId,
    domain,
  ]);
}
