import { createHash, randomBytes } from "node:crypto";
import {
  NewSsoDomain,
  SaveSsoConnection,
  SsoConfiguration,
  SsoConnection,
  SsoDomain,
  SsoDomainChallenge,
  SsoDomainChange,
} from "@harbour/contracts";
import { role, ssoConnection, ssoDomain, type Transaction } from "@harbour/db";
import {
  checkSsoConnection,
  checkSsoDomain,
  ssoDomainRecord,
  ssoProviderId,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  requirePermission,
  stepUpRefusal,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  removeSsoProvider,
  type SsoProviderProjection,
  setSsoProviderDomain,
  ssoEnabledFor,
  upsertSsoProvider,
} from "../services/sso";
import { staffNames } from "../services/staff";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Single sign-on configuration (PLAT-005; platform.md, Phase 2: single sign-on, rules 18 to 22;
 * ADR-0091). Reading needs `platform.tenant.manage`; every change also needs a fresh step-up.
 * Row-level security (migration 0095) checks the permission again. Audits carry ids and what
 * changed, never a key name, token or domain.
 */

const PERMISSION = "platform.tenant.manage" as const;
const tags = ["platform"];
const IdParam = z.object({ id: z.uuid() });

type ConnectionRow = typeof ssoConnection.$inferSelect;
type DomainRow = typeof ssoDomain.$inferSelect;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The permission, and the organisation's `platform.sso` flag (off by default; ADR-0091). */
async function requireSso(c: Context<AppEnv>): Promise<TenantAccess> {
  const access = await requirePermission(c, PERMISSION);
  if (!(await ssoEnabledFor(c.get("services"), access.tenantId))) {
    throw problems.featureDisabled("Single sign-on is not switched on for this organisation.");
  }
  return access;
}

/** Refuses a change without a fresh step-up (rule 22). */
async function requireChange(c: Context<AppEnv>): Promise<TenantAccess> {
  const access = await requireSso(c);
  if (!access.stepUpFresh) throw stepUpRefusal(access);
  return access;
}

const stale = () => problems.conflict("Reload the single sign-on settings and try again.");

function connectionOf(c: Context<AppEnv>, row: ConnectionRow): SsoConnection {
  const base = c.get("services").config.BETTER_AUTH_URL.replace(/\/$/, "");
  return {
    id: row.id,
    providerId: row.providerId,
    issuer: row.issuer,
    discoveryUrl: row.discoveryUrl,
    clientId: row.clientId,
    privateKeyRef: row.privateKeyRef,
    privateKeyId: row.privateKeyId,
    allowedRoleKeys: row.allowedRoleKeys,
    enabled: row.enabled,
    signInPath: "/api/auth/sign-in/sso",
    redirectUri: `${base}/api/auth/sso/callback/${row.providerId}`,
    version: row.version,
  };
}

async function domainsOf(tx: Transaction) {
  const rows = await tx
    .select()
    .from(ssoDomain)
    .where(isNull(ssoDomain.removedAt))
    .orderBy(asc(ssoDomain.domain));
  const names = await staffNames(
    tx,
    rows.map((r) => r.verifiedBy),
  );
  return rows.map((r) => domainOf(r, names));
}

const domainOf = (r: DomainRow, names: Awaited<ReturnType<typeof staffNames>>) => ({
  id: r.id,
  domain: r.domain,
  verifiedAt: r.verifiedAt?.toISOString() ?? null,
  verifiedBy: names(r.verifiedBy),
  version: r.version,
});

async function currentConnection(tx: Transaction) {
  const [row] = await tx.select().from(ssoConnection).where(isNull(ssoConnection.deletedAt));
  return row ?? null;
}

/** The verified domain Better Auth's row names (it needs one; the policy checks them all). */
async function firstVerifiedDomain(tx: Transaction): Promise<string> {
  const domains = await tx
    .select({ domain: ssoDomain.domain, verifiedAt: ssoDomain.verifiedAt })
    .from(ssoDomain)
    .where(isNull(ssoDomain.removedAt))
    .orderBy(asc(ssoDomain.domain));
  return domains.find((d) => d.verifiedAt)?.domain ?? "unverified.invalid";
}

/** Better Auth's row, brought in line after the organisation's change committed (fails closed). */
type Projection =
  | { kind: "upsert"; value: SsoProviderProjection }
  | { kind: "domain"; providerId: string; domain: string }
  | { kind: "remove"; providerId: string };

async function project(c: Context<AppEnv>, projection: Projection | null) {
  const pool = c.get("services").authPool;
  if (!projection) return;
  if (projection.kind === "upsert") await upsertSsoProvider(pool, projection.value);
  else if (projection.kind === "domain")
    await setSsoProviderDomain(pool, projection.providerId, projection.domain);
  else await removeSsoProvider(pool, projection.providerId);
}

/** After a domain change: the row follows the connection's state. */
async function domainProjection(tx: Transaction, row: ConnectionRow): Promise<Projection> {
  return row.enabled
    ? { kind: "domain", providerId: row.providerId, domain: await firstVerifiedDomain(tx) }
    : { kind: "remove", providerId: row.providerId };
}

/** The connection's own checks (rule 18), run before discovery and again when saving. */
async function checkConnection(
  c: Context<AppEnv>,
  tx: Transaction,
  input: z.infer<typeof SaveSsoConnection>,
  tenantId: string,
): Promise<void> {
  const roles = await tx
    .select({ key: role.key })
    .from(role)
    .where(and(isNull(role.deletedAt), isNull(role.archivedAt)));
  const check = checkSsoConnection(
    input,
    roles.map((r) => r.key),
    tenantId,
  );
  if (!check.ok) throw problems.invalid(check.problem);
  if (!(await c.get("services").ssoKeys.has(input.privateKeyRef))) {
    throw new HttpProblem(
      422,
      "sso_key_not_in_store",
      "There is no key with that name in the secret store.",
      "Ask Thapsus to add the key, then save again.",
    );
  }
  if (input.enabled && (await firstVerifiedDomain(tx)) === "unverified.invalid") {
    throw new HttpProblem(
      422,
      "sso_domain_required",
      "Verify at least one email domain before switching single sign-on on.",
    );
  }
}

async function loadDomain(tx: Transaction, id: string): Promise<DomainRow> {
  const [row] = await tx
    .select()
    .from(ssoDomain)
    .where(and(eq(ssoDomain.id, id), isNull(ssoDomain.removedAt)));
  if (!row) throw problems.notFound();
  return row;
}

export const ssoRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/sso",
      tags,
      summary: "The organisation's single sign-on connection and email domains",
      description: `${PERMISSION}. The key's store name only, never a key or token.`,
      security,
      responses: { 200: jsonBody(SsoConfiguration, "The configuration"), ...errorResponses },
    }),
    async (c) => {
      await requireSso(c);
      const body = await withTenant(c, async (tx) => {
        const row = await currentConnection(tx);
        return { connection: row ? connectionOf(c, row) : null, domains: await domainsOf(tx) };
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/sso/connection",
      tags,
      summary: "Save the OpenID Connect connection, or switch it on or off",
      description: `${PERMISSION} with step-up. https issuer and discovery URL, \`private_key_jwt\` only (client secrets refused), a key that exists in the managed store (checked, never read into the response), known roles. Switching on needs a verified domain. Audited without the key name.`,
      security,
      request: { body: { content: { "application/json": { schema: SaveSsoConnection } } } },
      responses: {
        200: jsonBody(SsoConnection, "Saved"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireChange(c);
      const input = c.req.valid("json");
      let projection: Projection | null = null;
      // Checked before anything leaves Harbour (#33 review H1).
      await withTenant(c, (tx) => checkConnection(c, tx, input, access.tenantId));
      // Endpoints are found now, so sign-in never fetches discovery (rule 18; ADR-0091).
      let endpoints: SsoProviderProjection["endpoints"] | null = null;
      if (input.enabled) {
        try {
          endpoints = await c.get("services").oidcDiscovery(input.issuer, input.discoveryUrl);
        } catch {
          throw new HttpProblem(
            422,
            "sso_discovery_failed",
            "We could not read the identity provider's settings.",
            "Check the issuer and discovery URL, which must be public https addresses.",
          );
        }
      }
      const body = await withTenant(c, async (tx) => {
        await checkConnection(c, tx, input, access.tenantId);
        const current = await currentConnection(tx);
        const values = {
          issuer: input.issuer,
          discoveryUrl: input.discoveryUrl,
          clientId: input.clientId,
          privateKeyRef: input.privateKeyRef,
          privateKeyId: input.privateKeyId,
          allowedRoleKeys: input.allowedRoleKeys,
          enabled: input.enabled,
        };
        let row: ConnectionRow | undefined;
        if (current) {
          if (input.expectedVersion !== current.version) throw stale();
          [row] = await tx
            .update(ssoConnection)
            .set(values)
            .where(
              and(eq(ssoConnection.id, current.id), eq(ssoConnection.version, current.version)),
            )
            .returning();
        } else {
          if (input.expectedVersion !== null) throw stale();
          [row] = await tx
            .insert(ssoConnection)
            .values({ ...values, providerId: ssoProviderId(access.tenantId) })
            .returning();
        }
        if (!row) throw stale();
        projection =
          row.enabled && endpoints
            ? {
                kind: "upsert",
                value: {
                  providerId: row.providerId,
                  issuer: row.issuer,
                  discoveryUrl: row.discoveryUrl,
                  clientId: row.clientId,
                  privateKeyId: row.privateKeyId,
                  endpoints,
                  domain: await firstVerifiedDomain(tx),
                },
              }
            : { kind: "remove", providerId: row.providerId };
        await auditInTx(tx, access, {
          action: current ? "platform.sso.connection_changed" : "platform.sso.connection_created",
          resourceType: "sso_connection",
          resourceId: row.id,
          scope: {
            enabled: row.enabled,
            wasEnabled: current?.enabled ?? false,
            roles: row.allowedRoleKeys.length,
            issuerChanged: current ? current.issuer !== row.issuer : true,
            keyChanged: current ? current.privateKeyRef !== row.privateKeyRef : true,
          },
          requestId: c.get("requestId"),
        });
        return connectionOf(c, row);
      });
      await project(c, projection);
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/sso/domains",
      tags,
      summary: "Claim an email domain and get the DNS record that proves it",
      description: `${PERMISSION} with step-up. The token is shown once and kept only as a hash. Public email domains are refused. Audited.`,
      security,
      request: { body: { content: { "application/json": { schema: NewSsoDomain } } } },
      responses: {
        201: jsonBody(SsoDomainChallenge, "Claimed"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireChange(c);
      const check = checkSsoDomain(c.req.valid("json").domain);
      if (!check.ok) throw problems.invalid(check.problem);
      const token = randomBytes(24).toString("base64url");
      const body = await withTenant(c, async (tx) => {
        const [row] = await tx
          .insert(ssoDomain)
          .values({ domain: check.domain, tokenSha256: sha256(token) })
          .onConflictDoNothing()
          .returning();
        if (!row) throw problems.conflict("That domain is already claimed here.");
        await auditInTx(tx, access, {
          action: "platform.sso.domain_claimed",
          resourceType: "sso_domain",
          resourceId: row.id,
          requestId: c.get("requestId"),
        });
        return { domain: domainOf(row, () => null), record: ssoDomainRecord(row.domain, token) };
      });
      return c.json(body, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/sso/domains/{id}/verify",
      tags,
      summary: "Check the domain's DNS record and mark it verified",
      description: `${PERMISSION} with step-up. Looks for the TXT record \`_harbour-verification.<domain>\` carrying the token. A domain another organisation verified is refused. Audited.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SsoDomainChange } } },
      },
      responses: {
        200: jsonBody(SsoDomain, "Verified"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireChange(c);
      const { id } = c.req.valid("param");
      const { expectedVersion } = c.req.valid("json");
      let projection: Projection | null = null;
      const body = await withTenant(c, async (tx) => {
        const row = await loadDomain(tx, id);
        if (row.version !== expectedVersion) throw stale();
        const records = await c.get("services").txtLookup(ssoDomainRecord(row.domain, "").name);
        const proved = records.some((r) => {
          const value = r.trim();
          return (
            value.startsWith("harbour-verification=") &&
            sha256(value.slice("harbour-verification=".length)) === row.tokenSha256
          );
        });
        if (!proved) {
          throw new HttpProblem(
            422,
            "sso_domain_not_proved",
            "We could not find the DNS record yet.",
            "Records can take up to a day to appear. Check the name and value, then try again.",
          );
        }
        let saved: DomainRow | undefined;
        try {
          [saved] = await tx
            .update(ssoDomain)
            .set({ verifiedAt: new Date(), verifiedBy: access.tenantUserId })
            .where(and(eq(ssoDomain.id, id), eq(ssoDomain.version, expectedVersion)))
            .returning();
        } catch (error) {
          const pg = (error as { cause?: { code?: string } }).cause ?? error;
          if ((pg as { code?: string }).code === "23505") {
            throw new HttpProblem(
              409,
              "sso_domain_verified_elsewhere",
              "Another organisation has verified this domain.",
            );
          }
          throw error;
        }
        if (!saved) throw stale();
        const connection = await currentConnection(tx);
        if (connection) projection = await domainProjection(tx, connection);
        await auditInTx(tx, access, {
          action: "platform.sso.domain_verified",
          resourceType: "sso_domain",
          resourceId: id,
          requestId: c.get("requestId"),
        });
        return domainOf(saved, await staffNames(tx, [saved.verifiedBy]));
      });
      await project(c, projection);
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/sso/domains/{id}/remove",
      tags,
      summary: "Stop using an email domain for single sign-on",
      description: `${PERMISSION} with step-up. Members at that domain sign in with Harbour's own methods. Audited.`,
      security,
      request: {
        params: IdParam,
        body: { content: { "application/json": { schema: SsoDomainChange } } },
      },
      responses: {
        200: jsonBody(SsoConfiguration, "Removed"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requireChange(c);
      const { id } = c.req.valid("param");
      const { expectedVersion } = c.req.valid("json");
      let projection: Projection | null = null;
      const body = await withTenant(c, async (tx) => {
        const row = await loadDomain(tx, id);
        if (row.version !== expectedVersion) throw stale();
        await tx.update(ssoDomain).set({ removedAt: new Date() }).where(eq(ssoDomain.id, id));
        let connection = await currentConnection(tx);
        // With no verified domain left, single sign-on switches off.
        if (connection?.enabled && (await firstVerifiedDomain(tx)) === "unverified.invalid") {
          const [off] = await tx
            .update(ssoConnection)
            .set({ enabled: false })
            .where(eq(ssoConnection.id, connection.id))
            .returning();
          connection = off ?? connection;
        }
        if (connection) projection = await domainProjection(tx, connection);
        await auditInTx(tx, access, {
          action: "platform.sso.domain_removed",
          resourceType: "sso_domain",
          resourceId: id,
          scope: { ssoStillOn: connection?.enabled ?? false },
          requestId: c.get("requestId"),
        });
        return {
          connection: connection ? connectionOf(c, connection) : null,
          domains: await domainsOf(tx),
        };
      });
      await project(c, projection);
      return c.json(body, 200);
    },
  );
