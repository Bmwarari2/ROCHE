import { BUILTIN_ROLES } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
});

afterAll(async () => {
  await db?.drop();
});

const roles = JSON.stringify(
  BUILTIN_ROLES.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    scopeKind: r.scopeKind,
  })),
);

describe("tenant provisioning by the operator", () => {
  it("creates the tenant, its built-in roles and an invited owner in one step", async () => {
    const tenantId = await inContext(db.pool("harbour_operator"), null, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT app.provision_tenant($1, $2, $3) AS id",
        [
          JSON.stringify({
            name: "New Provider",
            legalName: "New Provider Ltd",
            legalForm: "limited_company",
          }),
          roles,
          JSON.stringify({ displayName: "Nadia New", email: "Nadia@Example.invalid" }),
        ],
      );
      return rows[0]?.id as string;
    });
    const result = await inContext(
      db.pool("harbour_app"),
      ctx(tenantId, null, "tenant"),
      async (c) => {
        const tenant = await c.query("SELECT status FROM tenant");
        const roleCount = await c.query("SELECT count(*)::int AS n FROM role");
        const owner = await c.query(
          `SELECT tu.email, tu.status, r.key FROM tenant_user tu
         JOIN role_assignment ra ON ra.tenant_user_id = tu.id JOIN role r ON r.id = ra.role_id`,
        );
        return { tenant: tenant.rows[0], roles: roleCount.rows[0], owner: owner.rows[0] };
      },
    );
    expect(result).toEqual({
      tenant: { status: "onboarding" },
      roles: { n: BUILTIN_ROLES.length },
      owner: { email: "nadia@example.invalid", status: "invited", key: "owner" },
    });
  });

  it("is not available to the application role", async () => {
    await expect(
      inContext(db.pool("harbour_app"), ctx(TENANT_A, null, "tenant"), (c) =>
        c.query("SELECT app.provision_tenant('{}', '[]', '{}')"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot read people or users back", async () => {
    await expect(
      inContext(db.pool("harbour_operator"), null, (c) => c.query("SELECT * FROM tenant_user")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("support access requests", () => {
  it("lets an operator file a request that only that tenant can see and decide", async () => {
    const operatorId = await inContext(db.pool("harbour_owner"), null, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO operator_user (auth_user_id, display_name, role) VALUES ('auth-op', 'Ola Operator', 'support') RETURNING id`,
      );
      return rows[0]?.id;
    });
    await inContext(db.pool("harbour_operator"), ctx(TENANT_A, null, "none"), (c) =>
      c.query(
        `INSERT INTO support_access_request (tenant_id, operator_user_id, ticket_reference, reason)
         VALUES ($1, $2, 'SUP-1', 'Investigate a sync error reported by the manager')`,
        [TENANT_A, operatorId],
      ),
    );
    const visible = async (tenant: string) =>
      inContext(db.pool("harbour_app"), ctx(tenant, null, "tenant"), async (c) => {
        const { rows } = await c.query("SELECT ticket_reference FROM support_access_request");
        return rows.map((r) => r.ticket_reference);
      });
    expect(await visible(TENANT_A)).toEqual(["SUP-1"]);
    expect(await visible(TENANT_B)).toEqual([]);

    await expect(
      inContext(db.pool("harbour_operator"), ctx(TENANT_A, null, "none"), (c) =>
        c.query("UPDATE support_access_request SET decision = 'approved'"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("notification deliveries", () => {
  it("queues one delivery per non in-app channel when a notification is raised", async () => {
    const channels = await inContext(
      db.pool("harbour_app"),
      ctx(TENANT_A, ids.a.manager, "tenant"),
      async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO notification (recipient_tenant_user_id, kind, title, channels)
         VALUES ($1, 'test.kind', 'Test', '{in_app,push,email}') RETURNING id`,
          [ids.a.manager],
        );
        const deliveries = await c.query<{ channel: string; status: string }>(
          "SELECT channel, status FROM notification_delivery WHERE notification_id = $1 ORDER BY channel",
          [rows[0]?.id],
        );
        return deliveries.rows;
      },
    );
    expect(channels).toEqual([
      { channel: "email", status: "pending" },
      { channel: "push", status: "pending" },
    ]);
  });

  it("lets the worker see pending deliveries across tenants, and nothing else about people", async () => {
    const { rows } = await db
      .pool("harbour_worker")
      .query("SELECT count(*)::int AS n FROM notification_delivery WHERE status = 'pending'");
    expect(rows[0]?.n).toBeGreaterThanOrEqual(2);
    await expect(db.pool("harbour_worker").query("SELECT * FROM person")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("integration quarantine", () => {
  it("keeps quarantined inbound data inside its tenant", async () => {
    await inContext(db.pool("harbour_app"), ctx(TENANT_B, ids.b.manager, "tenant"), (c) =>
      c.query(
        `INSERT INTO integration_inbound (port, provider, external_id, status, payload, problems)
         VALUES ('councils.remittance', 'controcc', 'R-1', 'quarantined', '{}', '[{"path":"amount","message":"Required"}]')`,
      ),
    );
    const seenByA = await inContext(
      db.pool("harbour_app"),
      ctx(TENANT_A, ids.a.manager, "tenant"),
      async (c) => {
        const { rows } = await c.query("SELECT 1 FROM integration_inbound");
        return rows.length;
      },
    );
    expect(seenByA).toBe(0);
  });
});
