import { resolveTxt } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { discoverOIDCConfig } from "@better-auth/sso";
import { ssoSignInDecision, tenantOfSsoProvider } from "@harbour/domain";
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
  async has(ref: string): Promise<boolean> {
    return (await this.get(ref)) !== null;
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

interface SignInFacts {
  tenant_id: string;
  enabled: boolean;
  private_key_ref: string;
  allowed_role_keys: string[];
  verified_domains: string[];
  member_id: string | null;
  member_email: string | null;
  member_status: string | null;
  member_auth_user_id: string | null;
  member_role_keys: string[];
}

async function signInFacts(
  appPool: pg.Pool,
  providerId: string,
  email: string,
): Promise<SignInFacts | null> {
  const { rows } = await appPool.query<SignInFacts>("SELECT * FROM app.sso_sign_in_facts($1, $2)", [
    providerId,
    email,
  ]);
  return rows[0] ?? null;
}

export type SsoResolution =
  | { action: "continue" }
  | { action: "link"; userId: string; profile: "preserve" }
  | { action: "reject"; code: string; message: string };

export interface SsoHooks {
  resolveUser(input: {
    providerId: string;
    providerUser: { email: string; emailVerified: boolean };
  }): Promise<SsoResolution>;
  /** No key (`{}`) makes the plugin refuse the sign-in. */
  resolvePrivateKey(input: { providerId: string }): Promise<{ privateKeyPem?: string }>;
  /** After Better Auth created a sign-in for an invited member: link it (rule 20). */
  linkInvitedMember(providerId: string, authUserId: string): Promise<void>;
}

/** The hooks the SSO plugin calls; they run before anyone is signed in. */
export function createSsoHooks(deps: {
  appPool: pg.Pool;
  keys: SsoKeyStore;
  logger: Logger;
}): SsoHooks {
  return {
    async resolveUser({ providerId, providerUser }) {
      const facts = tenantOfSsoProvider(providerId)
        ? await signInFacts(deps.appPool, providerId, providerUser.email)
        : null;
      if (!facts)
        return { action: "reject", code: "sso_off", message: "Single sign-on is not set up." };
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
          facts.member_id && facts.member_email && facts.member_status
            ? {
                email: facts.member_email,
                status: facts.member_status as "active" | "invited",
                kind: "staff",
                roleKeys: facts.member_role_keys,
              }
            : null,
      });
      if (!decision.ok) {
        deps.logger.info(
          { event: "sso.sign_in_refused", tenantId: facts.tenant_id, code: decision.problem },
          "sso.sign_in_refused",
        );
        return { action: "reject", code: decision.problem, message: decision.message };
      }
      if (facts.member_auth_user_id)
        return { action: "link", userId: facts.member_auth_user_id, profile: "preserve" };
      // An invited member with no sign-in yet: Better Auth creates one, then
      // linkInvitedMember links it.
      return { action: "continue" };
    },
    async resolvePrivateKey({ providerId }) {
      if (!tenantOfSsoProvider(providerId)) return {};
      const facts = await signInFacts(deps.appPool, providerId, "");
      if (!facts?.enabled) return {};
      const pem = await deps.keys.get(facts.private_key_ref);
      return pem ? { privateKeyPem: pem } : {};
    },
    async linkInvitedMember(providerId, authUserId) {
      if (!tenantOfSsoProvider(providerId)) return;
      try {
        await deps.appPool.query("SELECT app.link_sso_member($1, $2)", [providerId, authUserId]);
      } catch (error) {
        // An active member was linked by resolveUser instead; anything else leaves a sign-in with
        // no membership, which reaches nothing.
        const code = String((error as { message?: string }).message ?? "");
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
  return async (issuer, discoveryUrl) => {
    const found = await discoverOIDCConfig({
      issuer,
      discoveryEndpoint: discoveryUrl,
      existingConfig: { tokenEndpointAuthentication: "private_key_jwt" },
      isTrustedOrigin: (url: string) => url.startsWith("https://"),
    });
    if (!found.authorizationEndpoint || !found.tokenEndpoint || !found.jwksEndpoint) {
      throw new Error("discovery_incomplete");
    }
    return {
      authorizationEndpoint: found.authorizationEndpoint,
      tokenEndpoint: found.tokenEndpoint,
      jwksEndpoint: found.jwksEndpoint,
      userInfoEndpoint: found.userInfoEndpoint ?? null,
    };
  };
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

const SSO_PATH = /^\/api\/auth\/(?:sign-in\/sso|sso\/callback\/([^/]+))$/;

/**
 * The identity providers' origins Better Auth must trust to fetch their token, key and user
 * endpoints: added only on the SSO sign-in and callback paths (the callback: that provider's
 * alone), so CSRF and redirect checks everywhere else keep Harbour's own origins (ADR-0091).
 */
export async function ssoTrustedOrigins(authPool: pg.Pool, request?: Request): Promise<string[]> {
  if (!request) return [];
  const match = SSO_PATH.exec(new URL(request.url).pathname);
  if (!match) return [];
  const { rows } = await authPool.query<{ oidc_config: string | null }>(
    match[1]
      ? "SELECT oidc_config FROM auth.sso_provider WHERE provider_id = $1"
      : "SELECT oidc_config FROM auth.sso_provider",
    match[1] ? [match[1]] : [],
  );
  const origins = new Set<string>();
  for (const row of rows) {
    const config = JSON.parse(row.oidc_config ?? "{}") as Record<string, unknown>;
    for (const key of [
      "issuer",
      "authorizationEndpoint",
      "tokenEndpoint",
      "jwksEndpoint",
      "userInfoEndpoint",
    ]) {
      const value = config[key];
      if (typeof value === "string" && value.startsWith("https://")) {
        origins.add(new URL(value).origin);
      }
    }
  }
  return [...origins];
}
