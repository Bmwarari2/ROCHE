import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The full export's record in the database (PLAT-015; platform-completions.md rules 12 to 15;
 * migration 0062; hazards HZ-011 and HZ-070): only holders of platform.export.create across the
 * organisation, and the export worker, see or change it; one at a time; a request is queued in
 * the requester's own name; the status moves forward only; the single download is the
 * requester's, once, while ready; and the export permission's old name is gone from role copies.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_EXPORTER = "0199f000-0000-7000-8000-000000000701";
const GRANT_WIDE = "0199f000-0000-7000-8000-000000000711";
const GRANT_AT_NORTH = "0199f000-0000-7000-8000-000000000712";
const app = () => db.pool("harbour_app");
const asMember =
  (userId: string, tenant = TENANT_A) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(tenant, userId, "tenant"), fn);
const asOwner = asMember(a.manager);
const asCarer = asMember(a.carer);
/** The export worker: no member, the organisation's view. */
const asJob = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const request = (c: pg.PoolClient, requestedBy: string = a.manager) =>
  c
    .query<{ id: string }>("INSERT INTO tenant_export (requested_by) VALUES ($1) RETURNING id", [
      requestedBy,
    ])
    .then((r) => r.rows[0]?.id ?? "");
const statusOf = (id: string) =>
  ownerDb((c) =>
    c.query("SELECT status FROM tenant_export WHERE id = $1", [id]).then((r) => r.rows[0]?.status),
  );
const move = (id: string, to: string) =>
  asJob((c) => {
    const ready =
      to === "ready"
        ? `, snapshot_at = now(), ready_at = now(), expires_at = now() + interval '1 day',
           storage_key = 'tenants/' || tenant_id || '/exports/' || id || '/export.zip',
           manifest_sha256 = repeat('a', 64)`
        : to === "failed"
          ? ", failed_at = now()"
          : "";
    return c.query(`UPDATE tenant_export SET status = $2${ready} WHERE id = $1`, [id, to]);
  });

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'exporter', 'Exporter', 'tenant', '{platform.export.create,platform.data.export}')`,
      [ROLE_EXPORTER],
    );
    // Grants holding the old name: across the organisation (renamed) and at a location (dropped).
    await c.query(
      `INSERT INTO access_grant (id, tenant_user_id, permissions, location_id, organisation_wide,
         valid_to, reason, granted_by) VALUES
         ($1, $3, '{platform.data.export}', NULL, true, now() + interval '1 day', 'Cover', $3),
         ($2, $3, '{platform.data.export,people.person.read}', $4, false, now() + interval '1 day',
          'Cover', $3)`,
      [GRANT_WIDE, GRANT_AT_NORTH, a.manager, a.locationNorth],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE_EXPORTER,
    ]);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-070 hazard HZ-011 the export record (migration 0062)", () => {
  let id = "";

  it("queues a request in the requester's own name, one at a time", async () => {
    id = await asOwner((c) => request(c));
    expect(await statusOf(id)).toBe("queued");
    await expect(asOwner((c) => request(c))).rejects.toThrow(/tenant_export_one_running_key/);
    await expect(asOwner((c) => request(c, a.carer))).rejects.toThrow(/row-level security/);
  });

  it("shows it to no one without the permission, and to no other organisation", async () => {
    expect(
      await asCarer((c) => c.query("SELECT id FROM tenant_export")).then((r) => r.rowCount),
    ).toBe(0);
    await expect(asCarer((c) => request(c, a.carer))).rejects.toThrow(/row-level security/);
    const other = await asMember(
      ids.b.manager,
      TENANT_B,
    )((c) => c.query("SELECT id FROM tenant_export"));
    expect(other.rowCount).toBe(0);
    expect(
      await asJob((c) => c.query("SELECT id FROM tenant_export")).then((r) => r.rowCount),
    ).toBe(1);
  });

  it.each([
    ["queued", "ready", false],
    ["queued", "expired", false],
    ["queued", "running", true],
    ["running", "queued", false],
    ["running", "ready", true],
    ["ready", "running", false],
    ["ready", "expired", true],
    ["expired", "ready", false],
  ] as const)("moves an export from %s to %s: %s", async (from, to, allowed) => {
    await ownerDb((c) => c.query("DELETE FROM tenant_export"));
    const fresh = await asOwner((c) => request(c));
    const path: Record<string, string[]> = {
      queued: [],
      running: ["running"],
      ready: ["running", "ready"],
      expired: ["running", "ready", "expired"],
    };
    for (const step of path[from] ?? []) await move(fresh, step);
    if (allowed) {
      await move(fresh, to);
      expect(await statusOf(fresh)).toBe(to);
    } else {
      await expect(move(fresh, to)).rejects.toThrow(
        /cannot move|final|tenant_export_ready|keeps its archive/,
      );
    }
  });

  it("records the single download, by the requester, once, while ready", async () => {
    await ownerDb((c) => c.query("DELETE FROM tenant_export"));
    const fresh = await asOwner((c) => request(c));
    const download = (by: string, run = asOwner) =>
      run((c) =>
        c.query(
          "UPDATE tenant_export SET downloaded_at = now(), downloaded_by = $2 WHERE id = $1",
          [fresh, by],
        ),
      );
    await expect(download(a.manager)).rejects.toThrow(/downloaded once/);
    await move(fresh, "running");
    await move(fresh, "ready");
    await expect(download(a.manager, asJob)).rejects.toThrow(/downloaded once/);
    await download(a.manager);
    await expect(download(a.manager)).rejects.toThrow(/downloaded once/);
  });

  it("freezes a ready export's archive, manifest, snapshot and expiry", async () => {
    await ownerDb((c) => c.query("DELETE FROM tenant_export"));
    const fresh = await asOwner((c) => request(c));
    await move(fresh, "running");
    await move(fresh, "ready");
    for (const change of [
      "expires_at = expires_at + interval '1 day'",
      "manifest_sha256 = repeat('b', 64)",
      "snapshot_at = now() - interval '1 hour'",
    ]) {
      await expect(
        asJob((c) => c.query(`UPDATE tenant_export SET ${change} WHERE id = $1`, [fresh])),
        change,
      ).rejects.toThrow(/keeps its archive/);
    }
  });

  it("keeps who asked and is never deleted or revoked in another's name", async () => {
    await ownerDb((c) => c.query("DELETE FROM tenant_export"));
    const fresh = await asOwner((c) => request(c));
    await expect(
      asJob((c) =>
        c.query("UPDATE tenant_export SET requested_by = $2 WHERE id = $1", [fresh, a.carer]),
      ),
    ).rejects.toThrow(/keeps who asked/);
    await expect(
      asJob((c) => c.query("UPDATE tenant_export SET deleted_at = now() WHERE id = $1", [fresh])),
    ).rejects.toThrow(/never deleted/);
    await expect(
      asJob((c) =>
        c.query(
          "UPDATE tenant_export SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1",
          [fresh, a.manager],
        ),
      ),
    ).rejects.toThrow(/in the name of the member/);
    await asOwner((c) =>
      c.query(
        "UPDATE tenant_export SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1",
        [fresh, a.manager],
      ),
    );
    expect(await statusOf(fresh)).toBe("revoked");
  });

  it("renames the old export permission in role copies (re-running the data migration)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../drizzle/0062_tenant_export.sql", import.meta.url), "utf8");
    const start = sql.indexOf("ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;");
    const statements = sql
      .slice(start)
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    const admin = db.pool("harbour_owner");
    for (const statement of statements) await admin.query(statement);
    const permissions = await ownerDb((c) =>
      c
        .query("SELECT permissions FROM role WHERE id = $1", [ROLE_EXPORTER])
        .then((r) => r.rows[0]?.permissions as string[]),
    );
    expect(permissions).toContain("platform.export.create");
    expect(permissions).not.toContain("platform.data.export");
    expect(permissions.filter((p) => p === "platform.export.create")).toHaveLength(1);
    const grants = await ownerDb((c) =>
      c
        .query("SELECT id, permissions FROM access_grant WHERE id = ANY ($1) ORDER BY id", [
          [GRANT_WIDE, GRANT_AT_NORTH],
        ])
        .then((r) => r.rows as { id: string; permissions: string[] }[]),
    );
    expect(grants).toEqual([
      { id: GRANT_WIDE, permissions: ["platform.export.create"] },
      { id: GRANT_AT_NORTH, permissions: ["people.person.read"] },
    ]);
    const audited = await ownerDb((c) =>
      c
        .query(
          "SELECT resource_id FROM audit_event WHERE action = 'platform.grant.permissions_migrated'",
        )
        .then((r) => r.rows.map((row) => row.resource_id).sort()),
    );
    expect(audited).toEqual([GRANT_WIDE, GRANT_AT_NORTH].sort());
  });
});
