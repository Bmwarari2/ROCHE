import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Single sign-on in the database (PLAT-005; platform.md, Phase 2: single sign-on, rules 18 to 22;
 * ADR-0091; migration 0095): cross-tenant denial, only platform.tenant.manage, no DELETE, one
 * connection per organisation, a domain verified by one organisation only, the callback's facts
 * and `app.link_sso_member` linking only an invited member at a verified domain. Invented members.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);
/** The SSO callback: no member yet, as the API calls the definer functions. */
const asCallback = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);

const PROVIDER_A = `harbour-${TENANT_A}`;
const PROVIDER_B = `harbour-${TENANT_B}`;
const TOKEN = "a".repeat(64);
const INVITED = "0199e000-0000-7000-8000-0000000009a1";
const STRANGER_AUTH = "auth-sso-stranger";
const INVITED_AUTH = "auth-sso-invited";

const connection = (c: pg.PoolClient, provider: string, enabled = true) =>
  c.query(
    `INSERT INTO sso_connection (provider_id, issuer, discovery_url, client_id, private_key_ref,
       allowed_role_keys, enabled)
     VALUES ($1, 'https://login.example.invalid', 'https://login.example.invalid/.well-known/openid-configuration',
       'harbour', 'harbour/sso/' || app.current_tenant_id() || '/test', '{care_worker,owner}', $2)
     RETURNING id`,
    [provider, enabled],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  for (const [tenant, member, roleId] of [
    [TENANT_A, a.manager, "0199e000-0000-7000-8000-000000000991"],
    [TENANT_B, b.manager, "0199e000-0000-7000-8000-000000000992"],
  ] as const) {
    await asOwner(tenant, async (c) => {
      await c.query(
        `INSERT INTO role (id, key, name, scope_kind, permissions)
         VALUES ($1, 'owner', 'Owner', 'tenant', '{platform.tenant.manage}')`,
        [roleId],
      );
      await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
        member,
        roleId,
      ]);
    });
  }
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Ivy Invited', 'ivy.invited@care.example.invalid', 'invited')`,
      [INVITED],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [INVITED, a.roleCarer, a.locationNorth],
    );
  });
  await db
    .pool("harbour_owner")
    .query(
      "INSERT INTO auth.user (id, name, email) VALUES ($1, 'Ivy Invited', 'ivy.invited@care.example.invalid'), ($2, 'Sam Stranger', 'sam@care.example.invalid')",
      [INVITED_AUTH, STRANGER_AUTH],
    );
  await asManager(async (c) => {
    await connection(c, PROVIDER_A);
    await c.query(
      `INSERT INTO sso_domain (domain, token_sha256, verified_at, verified_by)
       VALUES ('care.example.invalid', $1, now(), $2)`,
      [TOKEN, a.manager],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("PLAT-005 the SSO configuration stays in its organisation", () => {
  it("is invisible to another organisation", async () => {
    expect((await asOtherTenant((c) => c.query("SELECT id FROM sso_connection"))).rows).toEqual([]);
    expect((await asOtherTenant((c) => c.query("SELECT id FROM sso_domain"))).rows).toEqual([]);
    expect((await asManager((c) => c.query("SELECT id FROM sso_connection"))).rows).toHaveLength(1);
  });

  it("cannot be written into another organisation, or under its provider id", async () => {
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO sso_domain (tenant_id, domain, token_sha256) VALUES ($1, 'x.example.invalid', $2)`,
          [TENANT_A, TOKEN],
        ),
      ),
    ).rejects.toThrow();
    // The provider id must name the organisation it belongs to.
    await expect(asOtherTenant((c) => connection(c, PROVIDER_A))).rejects.toThrow(
      /sso_connection_provider_id/,
    );
  });
});

describe("only holders of platform.tenant.manage, and nothing is deleted", () => {
  it("hides it from a care worker and refuses their writes", async () => {
    expect((await asCarer((c) => c.query("SELECT id FROM sso_connection"))).rows).toEqual([]);
    await expect(
      asCarer((c) =>
        c.query("INSERT INTO sso_domain (domain, token_sha256) VALUES ('y.example.invalid', $1)", [
          TOKEN,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("never deletes a connection or a domain", async () => {
    await expect(asManager((c) => c.query("DELETE FROM sso_domain"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asManager((c) => c.query("DELETE FROM sso_connection"))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("the shape", () => {
  it("allows one connection per organisation, https only and a store name for the key", async () => {
    await expect(asManager((c) => connection(c, PROVIDER_A))).rejects.toThrow();
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO sso_connection (provider_id, issuer, discovery_url, client_id, private_key_ref, allowed_role_keys)
           VALUES ($1, 'http://login.example.invalid', 'https://login.example.invalid/d', 'c', 'harbour/sso/' || app.current_tenant_id() || '/b', '{owner}')`,
          [PROVIDER_B],
        ),
      ),
    ).rejects.toThrow(/sso_connection_https/);
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO sso_connection (provider_id, issuer, discovery_url, client_id, private_key_ref, allowed_role_keys)
           VALUES ($1, 'https://login.example.invalid', 'https://login.example.invalid/d', 'c', '-----BEGIN PRIVATE KEY-----', '{owner}')`,
          [PROVIDER_B],
        ),
      ),
    ).rejects.toThrow(/sso_connection_key_ref/);
  });

  it("lets only one organisation verify a domain", async () => {
    await asOtherTenant((c) =>
      c.query("INSERT INTO sso_domain (domain, token_sha256) VALUES ('care.example.invalid', $1)", [
        TOKEN,
      ]),
    );
    await expect(
      asOtherTenant((c) =>
        c.query(
          "UPDATE sso_domain SET verified_at = now(), verified_by = $1 WHERE domain = 'care.example.invalid'",
          [b.manager],
        ),
      ),
    ).rejects.toThrow(/sso_domain_verified_once_key/);
  });
});

describe("the SSO callback's facts and link (rules 15, 16, 20)", () => {
  it("returns the connection, verified domains and the member with that email, and nothing for another provider", async () => {
    const { rows } = await asCallback((c) =>
      c.query("SELECT * FROM app.sso_sign_in_facts($1, $2)", [
        PROVIDER_A,
        "Ivy.Invited@care.example.invalid",
      ]),
    );
    expect(rows[0]).toMatchObject({
      tenant_id: TENANT_A,
      enabled: true,
      verified_domains: ["care.example.invalid"],
      member_id: INVITED,
      member_status: "invited",
      member_auth_user_id: null,
      member_role_keys: ["care_worker"],
    });
    expect(
      (await asCallback((c) => c.query("SELECT * FROM app.sso_sign_in_facts('google', 'x')"))).rows,
    ).toEqual([]);
  });

  it("refuses to link a sign-in whose address is not an invited member's", async () => {
    await db
      .pool("harbour_owner")
      .query(
        "INSERT INTO auth.account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('acc-sam', 'sub-sam', $1, $2, now(), now())",
        [PROVIDER_A, STRANGER_AUTH],
      );
    await expect(
      asCallback((c) => c.query("SELECT app.link_sso_member($1, $2)", [PROVIDER_A, STRANGER_AUTH])),
    ).rejects.toThrow(/member_not_invited/);
  });

  it("refuses to link a sign-in that did not come through this organisation's provider", async () => {
    await expect(
      asCallback((c) => c.query("SELECT app.link_sso_member($1, $2)", [PROVIDER_A, INVITED_AUTH])),
    ).rejects.toThrow(/sso_account_missing/);
  });

  it("links an invited member at a verified domain, once, and audits it", async () => {
    await db
      .pool("harbour_owner")
      .query(
        "INSERT INTO auth.account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('acc-ivy', 'sub-ivy', $1, $2, now(), now())",
        [PROVIDER_A, INVITED_AUTH],
      );
    const { rows } = await asCallback((c) =>
      c.query("SELECT app.link_sso_member($1, $2) AS id", [PROVIDER_A, INVITED_AUTH]),
    );
    expect(rows[0]?.id).toBe(INVITED);
    const member = await asOwner(TENANT_A, (c) =>
      c.query("SELECT status, auth_user_id FROM tenant_user WHERE id = $1", [INVITED]),
    );
    expect(member.rows[0]).toEqual({ status: "active", auth_user_id: INVITED_AUTH });
    const audit = await asOwner(TENANT_A, (c) =>
      c.query("SELECT scope FROM audit_event WHERE action = 'platform.sso.member_linked'"),
    );
    expect(audit.rows).toHaveLength(1);
    await expect(
      asCallback((c) => c.query("SELECT app.link_sso_member($1, $2)", [PROVIDER_A, INVITED_AUTH])),
    ).rejects.toThrow(/already_member/);
  });

  it("hands the key's store name only for a switched-on connection", async () => {
    const { rows } = await asCallback((c) =>
      c.query("SELECT app.sso_key_ref($1) AS ref", [PROVIDER_A]),
    );
    expect(rows[0]?.ref).toBe(`harbour/sso/${TENANT_A}/test`);
  });

  it("switches off and unverifies the domains when the issuer changes (#33 review H2)", async () => {
    await asManager((c) =>
      c.query("UPDATE sso_connection SET issuer = 'https://other.example.invalid'"),
    );
    const [conn] = (await asManager((c) => c.query("SELECT enabled FROM sso_connection"))).rows;
    expect(conn?.enabled).toBe(false);
    const domains = await asManager((c) =>
      c.query("SELECT verified_at FROM sso_domain WHERE removed_at IS NULL"),
    );
    expect(domains.rows.every((d) => d.verified_at === null)).toBe(true);
  });

  it("refuses while the connection is off", async () => {
    await asManager((c) => c.query("UPDATE sso_connection SET enabled = false"));
    await expect(
      asCallback((c) => c.query("SELECT app.link_sso_member($1, $2)", [PROVIDER_A, STRANGER_AUTH])),
    ).rejects.toThrow(/sso_off/);
  });
});
