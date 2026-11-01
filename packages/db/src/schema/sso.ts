import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { tenant, tenantUser } from "./platform";

/**
 * An organisation's OpenID Connect sign-in (PLAT-005; platform.md, Phase 2: single sign-on, rules
 * 18 to 22; ADR-0091; migration 0095). One per organisation. Holds the store name of the private
 * key the client signs with (`private_key_jwt`), never a secret or a key. Better Auth's
 * `auth.sso_provider` row is a projection of this one that only the API writes. Tenant
 * configuration, kept while current.
 */
export const ssoConnection = pgTable(
  "sso_connection",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** `harbour-<tenant id>`, the id Better Auth knows the connection by (`ssoProviderId`). */
    providerId: text("provider_id").notNull(),
    issuer: text("issuer").notNull(),
    discoveryUrl: text("discovery_url").notNull(),
    clientId: text("client_id").notNull(),
    /** The key's name in the managed store, under `harbour/sso/<tenant id>/` (`isSsoKeyRefFor`). */
    privateKeyRef: text("private_key_ref").notNull(),
    /** The key id (`kid`) the provider registered, if it needs one. */
    privateKeyId: text("private_key_id"),
    /** Role keys that may sign in with SSO (rule 16). */
    allowedRoleKeys: text("allowed_role_keys").array().notNull(),
    enabled: boolean("enabled").notNull().default(false),
    ...mutableColumns(),
  },
  (t) => [
    unique("sso_connection_tenant_id_id_key").on(t.tenantId, t.id),
    unique("sso_connection_provider_id_key").on(t.providerId),
    uniqueIndex("sso_connection_one_per_tenant_key").on(t.tenantId).where(sql`deleted_at IS NULL`),
    check("sso_connection_provider_id", sql`provider_id = 'harbour-' || tenant_id::text`),
    check("sso_connection_https", sql`issuer ~ '^https://' AND discovery_url ~ '^https://'`),
    check(
      "sso_connection_key_ref",
      sql`private_key_ref ~ ('^harbour/sso/' || tenant_id::text || '/[a-z0-9][a-z0-9-]{0,62}$')`,
    ),
    check("sso_connection_client_id", sql`length(btrim(client_id)) > 0`),
    check("sso_connection_roles", sql`cardinality(allowed_role_keys) > 0`),
  ],
);

/**
 * An email domain an organisation claims for SSO (rule 19), proved by a DNS TXT record. The token
 * is kept only as its SHA-256. A domain verified by one organisation cannot be verified by another.
 */
export const ssoDomain = pgTable(
  "sso_domain",
  {
    id: id(),
    tenantId: tenantId().references(() => tenant.id),
    /** Lower case (`checkSsoDomain`). */
    domain: text("domain").notNull(),
    tokenSha256: text("token_sha256").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: uuid("verified_by"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("sso_domain_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("sso_domain_tenant_domain_key")
      .on(t.tenantId, t.domain)
      .where(sql`removed_at IS NULL`),
    // Verified by one organisation at a time, across organisations (a constraint sees every row).
    uniqueIndex("sso_domain_verified_once_key")
      .on(t.domain)
      .where(sql`verified_at IS NOT NULL AND removed_at IS NULL`),
    foreignKey({
      name: "sso_domain_verified_by_fk",
      columns: [t.tenantId, t.verifiedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "sso_domain_domain",
      sql`domain = lower(domain) AND domain ~ '^[a-z0-9.-]+\\.[a-z0-9-]+$'`,
    ),
    check("sso_domain_token", sql`token_sha256 ~ '^[0-9a-f]{64}$'`),
    check("sso_domain_verified", sql`(verified_at IS NULL) = (verified_by IS NULL)`),
  ],
);
