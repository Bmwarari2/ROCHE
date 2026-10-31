import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Crypto-shredding (PLAT-012, ADR-0109, migration 0117): a whole-organisation shred request is
 * reached only by tenant-wide holders of platform.retention.manage, made in the requester's own
 * name, approved by someone else (with its certificate) or cancelled by the requester, once, and
 * never deleted; another organisation never sees it. Certificates name two different people.
 */

let db: TestDatabase;
const app = () => db.pool("harbour_app");
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>, tenant = TENANT_A) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);

const A = {
  first: ids.a.manager,
  second: "0193a000-0000-7000-8000-000000000306",
  noRetention: ids.a.carer,
  roleRetention: "0193a000-0000-7000-8000-000000000606",
};
const B = { roleRetention: "0193b000-0000-7000-8000-000000000606" };
const REASON = "Contract ended; the full export was taken and acknowledged.";

const as = <T>(
  who: string,
  fn: (c: pg.PoolClient) => Promise<T>,
  scope: "tenant" | "locations" = "tenant",
) =>
  inContext(
    app(),
    ctx(TENANT_A, who, scope, scope === "locations" ? [ids.a.locationNorth] : []),
    fn,
  );

const ask = (c: pg.PoolClient, who: string) =>
  c.query<{ id: string }>(
    `INSERT INTO tenant_shred_request (reason, export_confirmed, requested_by) VALUES ($1, true, $2) RETURNING id`,
    [REASON, who],
  );

async function certificate(
  c: pg.PoolClient,
  requestedBy: string,
  approvedBy: string,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO destruction_certificate (record_class, subject_type, subject_ids, record_count,
       retention_rule, reason, method, requested_by, approved_by, key_versions)
     VALUES ('tenant_exit', 'tenant', ARRAY[$1]::uuid[], 1, '{}', $2, 'kms_key_destroy:local', $3, $4,
       '[{"name":"local/v1","destroyAt":"2026-11-30T00:00:00Z"}]') RETURNING id`,
    [TENANT_A, REASON, requestedBy, approvedBy],
  );
  return rows[0]?.id ?? "";
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
       VALUES ($1, 'auth-a-second', 'Sam Second', 'sam.second@example.invalid', 'active')`,
      [A.second],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'records', 'Records', 'tenant', '{platform.retention.manage}')`,
      [A.roleRetention],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $3, NULL), ($2, $3, NULL)`,
      [A.first, A.second, A.roleRetention],
    );
  });
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'records', 'Records', 'tenant', '{platform.retention.manage}')`,
      [B.roleRetention],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, NULL)`,
      [ids.b.manager, B.roleRetention],
    );
  }, TENANT_B);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("tenant_shred_request", () => {
  it("is made pending in the requester's own name, approved by a second person with its certificate", async () => {
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await as(A.second, async (c) => {
      const cert = await certificate(c, A.first, A.second);
      const { rowCount } = await c.query(
        `UPDATE tenant_shred_request SET status = 'approved', decided_by = $2, decided_at = now(),
           certificate_id = $3 WHERE id = $1`,
        [id, A.second, cert],
      );
      expect(rowCount).toBe(1);
    });
    // Decided once: the app role no longer reaches it, the guard refuses even the owner, and
    // nobody deletes it.
    const again = await as(A.second, (c) =>
      c.query(
        "UPDATE tenant_shred_request SET status = 'cancelled', decided_by = $2 WHERE id = $1",
        [id, A.second],
      ),
    );
    expect(again.rowCount).toBe(0);
    await expect(
      ownerDb((c) =>
        c.query("UPDATE tenant_shred_request SET status = 'pending' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/decided shred request never changes/);
    await expect(
      ownerDb((c) =>
        c.query("UPDATE tenant_shred_request SET reason = $2 WHERE id = $1", [
          id,
          `${REASON} Changed afterwards.`,
        ]),
      ),
    ).rejects.toThrow(/requester and reason never change/);
    const kept = await as(A.first, (c) =>
      c.query<{ status: string }>("SELECT status FROM tenant_shred_request WHERE id = $1", [id]),
    );
    expect(kept.rows[0]?.status).toBe("approved");
    await expect(
      as(A.first, (c) => c.query("DELETE FROM tenant_shred_request WHERE id = $1", [id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses the requester as approver, in the database itself", async () => {
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await expect(
      as(A.first, async (c) => {
        const cert = await certificate(c, A.first, A.second);
        await c.query(
          `UPDATE tenant_shred_request SET status = 'approved', decided_by = $2, decided_at = now(),
             certificate_id = $3 WHERE id = $1`,
          [id, A.first, cert],
        );
      }),
    ).rejects.toThrow(/tenant_shred_request_two_people/);
    // The requester cancels their own; one pending at a time, so a new one may follow.
    await as(A.first, (c) =>
      c.query(
        "UPDATE tenant_shred_request SET status = 'cancelled', decided_by = $2, decided_at = now() WHERE id = $1",
        [id, A.first],
      ),
    );
  });

  it("allows one pending request at a time, and only a cancel by the requester", async () => {
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await expect(as(A.second, (c) => ask(c, A.second))).rejects.toThrow(
      /tenant_shred_request_one_pending/,
    );
    await expect(
      as(A.second, (c) =>
        c.query(
          "UPDATE tenant_shred_request SET status = 'cancelled', decided_by = $2, decided_at = now() WHERE id = $1",
          [id, A.second],
        ),
      ),
    ).rejects.toThrow(/tenant_shred_request_cancel/);
    await as(A.first, (c) =>
      c.query(
        "UPDATE tenant_shred_request SET status = 'cancelled', decided_by = $2, decided_at = now() WHERE id = $1",
        [id, A.first],
      ),
    );
  });

  it("refuses a request in someone else's name, without the permission, or from a location scope", async () => {
    await expect(as(A.first, (c) => ask(c, A.second))).rejects.toThrow(/row-level security/);
    await expect(as(A.noRetention, (c) => ask(c, A.noRetention))).rejects.toThrow(
      /row-level security/,
    );
    await expect(as(A.first, (c) => ask(c, A.first), "locations")).rejects.toThrow(
      /row-level security/,
    );
  });

  it("is never seen by another organisation", async () => {
    const seen = await inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), (c) =>
      c.query("SELECT id FROM tenant_shred_request"),
    );
    expect(seen.rowCount).toBe(0);
  });
});

describe("destruction_certificate", () => {
  it("refuses the same person as requester and approver, and a half-written signature", async () => {
    await expect(as(A.first, (c) => certificate(c, A.first, A.first))).rejects.toThrow(
      /destruction_certificate_two_people/,
    );
    await expect(
      as(A.first, (c) =>
        c.query(
          `INSERT INTO destruction_certificate (record_class, subject_type, subject_ids, record_count,
             retention_rule, reason, method, signature)
           VALUES ('x', 'document', '{}', 0, '{}', 'r', 'm', 'abc')`,
        ),
      ),
    ).rejects.toThrow(/destruction_certificate_signed/);
  });
});
