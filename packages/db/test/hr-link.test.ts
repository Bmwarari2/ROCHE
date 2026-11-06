import { readFileSync } from "node:fs";
import { BUILTIN_ROLES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The Thapsus-HR link in the database (integrations.md section 11.3; INTG-014; slice 87;
 * migration 0140): cross-tenant denial for every new table; nothing seen without an
 * `integrations.hr_link.*` permission; links proposed and made by the sync alone and decided by a
 * reviewer in their own name, never to their own staff file (hazard HZ-133); the connection only
 * with a UK workspace on the UK host (rule 1); the built-in role backfill. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const owner = () => db.pool("harbour_owner");
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
/** Holds integrations.hr_link.review and .read across the organisation. */
const asReviewer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** Holds integrations.hr_link.manage. */
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "tenant"), fn);
/** Holds nothing for the link. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const CARER_FILE = "0199f000-0000-7000-8000-000000001401";
const MANAGER_FILE = "0199f000-0000-7000-8000-000000001402";
const REVIEW_LINK = "0199f000-0000-7000-8000-000000001411";
const OWN_LINK = "0199f000-0000-7000-8000-000000001412";
const TABLES = ["hr_person_link", "hr_location_link", "hr_sync_state", "hr_delivery"] as const;

const settings = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    workspaceSlug: "demo",
    homeRegion: "uk",
    apiBaseUrl: "https://api.uk.thapsus.example.invalid",
    ...over,
  });
const connect = (c: pg.PoolClient, over: Record<string, unknown> = {}) =>
  c.query(
    `INSERT INTO integration_connection (port, provider, status, settings)
     VALUES ('integrations.hr_link', 'thapsus_hr', 'connected', $1::jsonb)`,
    [settings(over)],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(owner());
  await inContext(owner(), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f000-0000-7000-8000-000000001421', 'link_reviewer', 'Link reviewer', 'tenant',
          '{integrations.hr_link.review,integrations.hr_link.read}'),
         ('0199f000-0000-7000-8000-000000001422', 'link_manager', 'Link manager', 'tenant',
          '{integrations.hr_link.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id) VALUES
         ($1, '0199f000-0000-7000-8000-000000001421'), ($2, '0199f000-0000-7000-8000-000000001422')`,
      [a.manager, a.northManager],
    );
    await c.query(
      `INSERT INTO staff_profile (id, tenant_user_id, job_title) VALUES
         ($1, $3, 'Care worker'), ($2, $4, 'Registered Manager')`,
      [CARER_FILE, MANAGER_FILE, a.carer, a.manager],
    );
  });
  await asSystem(async (c) => {
    await c.query(
      `INSERT INTO hr_person_link (id, hr_employee_id, staff_profile_id, state, review_reason) VALUES
         ($1, 'emp_1001', $3, 'review', 'conflict'), ($2, 'emp_1002', $4, 'review', 'ambiguous')`,
      [REVIEW_LINK, OWN_LINK, CARER_FILE, MANAGER_FILE],
    );
    await c.query(
      "INSERT INTO hr_location_link (location_id, hr_location_id) VALUES ($1, 'loc_north')",
      [a.locationNorth],
    );
    await c.query(
      "INSERT INTO hr_sync_state (kind, last_good_sync_at) VALUES ('employees', now())",
    );
    await c.query(
      `INSERT INTO hr_delivery (kind, harbour_ref, idempotency_key)
       VALUES ('starter', $1, '0199f000-0000-7000-8000-000000001431')`,
      [CARER_FILE],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-133 the HR link's tables keep each organisation's links to itself", () => {
  it.each(TABLES)("%s is not seen from another organisation", async (table) => {
    const rows = await asOtherTenant((c) => c.query(`SELECT 1 FROM ${table}`));
    expect(rows.rows).toHaveLength(0);
    expect((await asReviewer((c) => c.query(`SELECT 1 FROM ${table}`))).rows.length).toBe(
      1 + (table === "hr_person_link" ? 1 : 0),
    );
  });

  it.each(TABLES)("%s is not seen without an HR link permission", async (table) => {
    expect((await asCarer((c) => c.query(`SELECT 1 FROM ${table}`))).rows).toHaveLength(0);
  });

  it.each(TABLES)("%s cannot be deleted from", async (table) => {
    await expect(asSystem((c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow();
  });

  it("refuses a row written into another organisation", async () => {
    await expect(
      asSystem((c) =>
        c.query("INSERT INTO hr_sync_state (tenant_id, kind) VALUES ($1, 'locations')", [TENANT_B]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-133 a match is made by the sync and decided by a person in their own name (rule 3)", () => {
  it("lets only the sync propose a link", async () => {
    await expect(
      asReviewer((c) =>
        c.query(
          "INSERT INTO hr_person_link (hr_employee_id, state, review_reason) VALUES ('emp_2001', 'review', 'no_match')",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a decision in someone else's name, and a reviewer changing the sync's fields", async () => {
    await expect(
      asReviewer((c) =>
        c.query(
          `UPDATE hr_person_link SET state = 'linked', match_method = 'manual', review_reason = NULL,
             confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
          [REVIEW_LINK, a.northManager],
        ),
      ),
    ).rejects.toThrow(/hr_link_not_you/);
    await expect(
      asReviewer((c) =>
        c.query("UPDATE hr_person_link SET leaving_on = '2099-01-01' WHERE id = $1", [REVIEW_LINK]),
      ),
    ).rejects.toThrow(/hr_link_sync_fields/);
    await expect(
      asReviewer((c) =>
        c.query("UPDATE hr_person_link SET hr_employee_id = 'emp_9' WHERE id = $1", [REVIEW_LINK]),
      ),
    ).rejects.toThrow(/hr_link_sync_fields/);
  });

  it("never lets a reviewer confirm a match to their own staff file", async () => {
    await expect(
      asReviewer((c) =>
        c.query(
          `UPDATE hr_person_link SET state = 'linked', match_method = 'manual', review_reason = NULL,
             confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
          [OWN_LINK, a.manager],
        ),
      ),
    ).rejects.toThrow(/hr_link_own_file/);
  });

  it("refuses a decision from someone without integrations.hr_link.review", async () => {
    const changed = await asManager((c) =>
      c.query(
        `UPDATE hr_person_link SET state = 'rejected', review_reason = NULL,
           confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
        [REVIEW_LINK, a.northManager],
      ),
    );
    expect(changed.rowCount).toBe(0);
  });

  it("confirms a match manually, and never links one staff file twice", async () => {
    await asReviewer((c) =>
      c.query(
        `UPDATE hr_person_link SET state = 'linked', match_method = 'manual', review_reason = NULL,
           confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
        [REVIEW_LINK, a.manager],
      ),
    );
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO hr_person_link (hr_employee_id, staff_profile_id, state, match_method)
           VALUES ('emp_3001', $1, 'linked', 'employee_number')`,
          [CARER_FILE],
        ),
      ),
    ).rejects.toThrow(/hr_person_link_staff_key/);
    await expect(
      asSystem((c) =>
        c.query(
          "INSERT INTO hr_person_link (hr_employee_id, state, review_reason) VALUES ('emp_1001', 'review', 'no_match')",
        ),
      ),
    ).rejects.toThrow(/hr_person_link_employee_key/);
  });

  it("refuses a link without its staff file, and a manual link nobody confirmed", async () => {
    await expect(
      asSystem((c) =>
        c.query(
          "INSERT INTO hr_person_link (hr_employee_id, state, match_method) VALUES ('emp_4001', 'linked', 'employee_number')",
        ),
      ),
    ).rejects.toThrow(/hr_person_link_state/);
    await expect(
      asSystem((c) =>
        c.query(
          "INSERT INTO hr_person_link (hr_employee_id, staff_profile_id, state, match_method) VALUES ('emp_4002', $1, 'linked', 'manual')",
          [MANAGER_FILE],
        ),
      ),
    ).rejects.toThrow(/hr_person_link_state/);
    await expect(
      asSystem((c) =>
        c.query(
          "INSERT INTO hr_person_link (hr_employee_id, state, review_reason) VALUES ('Ada Example', 'review', 'no_match')",
        ),
      ),
    ).rejects.toThrow(/hr_person_link_values/);
  });
});

describe("the sync position and the delivery log are the sync's alone", () => {
  it("refuses writes from a person, even one who manages the link", async () => {
    await expect(
      asManager((c) => c.query("INSERT INTO hr_sync_state (kind) VALUES ('absences')")),
    ).rejects.toThrow(/row-level security/);
    const changed = await asManager((c) =>
      c.query("UPDATE hr_delivery SET attempts = attempts + 1"),
    );
    expect(changed.rowCount).toBe(0);
  });

  it("records a delivery as sent only with Thapsus-HR's identifier", async () => {
    await expect(
      asSystem((c) => c.query("UPDATE hr_delivery SET state = 'sent', sent_at = now()")),
    ).rejects.toThrow(/hr_delivery_values/);
    await asSystem((c) =>
      c.query("UPDATE hr_delivery SET state = 'sent', sent_at = now(), hr_id = 'emp_5001'"),
    );
  });

  it("lets a manager map a location, and nobody else", async () => {
    await asManager((c) =>
      c.query(
        "INSERT INTO hr_location_link (location_id, hr_location_id) VALUES ($1, 'loc_south')",
        [a.locationSouth],
      ),
    );
    await expect(
      asReviewer((c) =>
        c.query("INSERT INTO hr_location_link (location_id, hr_location_id) VALUES ($1, 'loc_x')", [
          a.locationSouth,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-133 the connection only with a UK workspace on the UK host (rule 1)", () => {
  it.each([
    ["a home region outside the UK", { homeRegion: "eu" }],
    ["a host that is not the UK one", { apiBaseUrl: "https://api.eu.thapsus.example.invalid" }],
    ["plain HTTP", { apiBaseUrl: "http://api.uk.thapsus.example.invalid" }],
    ["credentials in the URL", { apiBaseUrl: "https://user:pw@api.uk.thapsus.example.invalid" }],
    ["a port", { apiBaseUrl: "https://api.uk.thapsus.example.invalid:8443" }],
  ])("refuses %s", async (_, over) => {
    await expect(asManager((c) => connect(c, over))).rejects.toThrow(
      /integration_connection_hr_link_uk/,
    );
  });

  it("lets only a holder of integrations.hr_link.manage connect", async () => {
    await expect(asReviewer((c) => connect(c))).rejects.toThrow(/row-level security/);
    await asManager((c) => connect(c));
    const changed = await asReviewer((c) =>
      c.query(
        "UPDATE integration_connection SET status = 'disconnected' WHERE port = 'integrations.hr_link'",
      ),
    );
    expect(changed.rowCount).toBe(0);
  });
});

describe("existing organisations' built-in roles (migration 0140)", () => {
  it("gain the HR link permissions where the built-in definitions now hold them, once", async () => {
    const sql = readFileSync(new URL("../drizzle/0140_hr_link.sql", import.meta.url), "utf8");
    const start = sql.indexOf("ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;");
    const block = sql
      .slice(start)
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        `INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES
           ('deputy_manager', 'Deputy manager', 'location', '{care.plan.read}', true),
           ('care_coordinator', 'Care coordinator', 'location', '{integrations.hr_link.read}', true)`,
      ),
    );
    const run = async () => {
      const client = await owner().connect();
      try {
        await client.query("BEGIN");
        for (const statement of block) await client.query(statement);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    };
    await run();
    await run();
    const roles = await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query<{ key: string; permissions: string[] }>(
        "SELECT key, permissions FROM role WHERE key IN ('deputy_manager', 'care_coordinator') AND is_builtin ORDER BY key",
      ),
    );
    expect(roles.rows).toEqual([
      { key: "care_coordinator", permissions: ["integrations.hr_link.read"] },
      {
        key: "deputy_manager",
        permissions: ["care.plan.read", "integrations.hr_link.review", "integrations.hr_link.read"],
      },
    ]);
    const events = await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        "SELECT 1 FROM audit_event WHERE action = 'platform.role.permissions_migrated' AND scope->>'migration' = '0140_hr_link'",
      ),
    );
    expect(events.rows).toHaveLength(1);
    const holders = (permission: string) =>
      BUILTIN_ROLES.filter((r) => (r.permissions as readonly string[]).includes(permission))
        .map((r) => r.key)
        .sort();
    expect(holders("integrations.hr_link.manage")).toEqual(["hr", "owner", "registered_manager"]);
    expect(holders("integrations.hr_link.review")).toEqual([
      "deputy_manager",
      "hr",
      "owner",
      "registered_manager",
    ]);
    expect(holders("integrations.hr_link.read")).toEqual([
      "care_coordinator",
      "deputy_manager",
      "hr",
      "owner",
      "registered_manager",
    ]);
  });
});
