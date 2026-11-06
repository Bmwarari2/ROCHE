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

let exportId = "";
const ask = (c: pg.PoolClient, who: string) =>
  c.query<{ id: string }>(
    `INSERT INTO tenant_shred_request (reason, export_id, requested_by) VALUES ($1, $2, $3) RETURNING id`,
    [REASON, exportId, who],
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
    exportId =
      (
        await c.query<{ id: string }>(
          `INSERT INTO tenant_export (kind, status, requested_by, ready_at, downloaded_at, downloaded_by)
           VALUES ('full', 'expired', $1, now(), now(), $1) RETURNING id`,
          [A.first],
        )
      ).rows[0]?.id ?? "";
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

const ownerAs = <T>(who: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, who, "tenant"), fn);
const decide = (c: pg.PoolClient, id: string, status: string, who: string) =>
  c.query(
    "UPDATE tenant_shred_request SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1",
    [id, status, who],
  );
const complete = (c: pg.PoolClient, id: string, certificateId: string) =>
  c.query(
    "UPDATE tenant_shred_request SET status = 'approved', certificate_id = $2 WHERE id = $1",
    [id, certificateId],
  );

describe("tenant_shred_request", () => {
  it("moves pending, to shredding by a second person, to approved with its certificate, and stops", async () => {
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await as(A.second, async (c) =>
      expect((await decide(c, id, "shredding", A.second)).rowCount).toBe(1),
    );
    // Shredding: never cancelled, and its approver and time never change.
    await expect(ownerAs(A.second, (c) => decide(c, id, "cancelled", A.second))).rejects.toThrow(
      /decided shred request never changes/,
    );
    await expect(
      as(A.second, async (c) => {
        const cert = await certificate(c, A.first, A.second);
        await c.query(
          "UPDATE tenant_shred_request SET status = 'approved', certificate_id = $2, decided_at = now() - interval '1 hour' WHERE id = $1",
          [id, cert],
        );
      }),
    ).rejects.toThrow(/decided shred request never changes/);
    await expect(
      as(A.second, (c) => complete(c, id, "0193a000-0000-7000-8000-00000000ffff")),
    ).rejects.toThrow(/tenant_shred_request_certificate_fk/);
    await as(A.second, async (c) => {
      const cert = await certificate(c, A.first, A.second);
      expect((await complete(c, id, cert)).rowCount).toBe(1);
    });
    // Approved: the app role and the owner no longer reach it, and nobody deletes it.
    expect((await as(A.second, (c) => decide(c, id, "cancelled", A.second))).rowCount).toBe(0);
    expect((await ownerAs(A.second, (c) => decide(c, id, "pending", A.second))).rowCount).toBe(0);
    await expect(
      as(A.first, (c) => c.query("DELETE FROM tenant_shred_request WHERE id = $1", [id])),
    ).rejects.toThrow(/permission denied/);
    const kept = await as(A.first, (c) =>
      c.query<{ status: string }>("SELECT status FROM tenant_shred_request WHERE id = $1", [id]),
    );
    expect(kept.rows[0]?.status).toBe("approved");
  });

  it("refuses the requester as approver, in the database itself", async () => {
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await expect(as(A.first, (c) => decide(c, id, "shredding", A.first))).rejects.toThrow(
      /tenant_shred_request_two_people/,
    );
    await as(A.first, (c) => decide(c, id, "cancelled", A.first));
  });

  it("allows one open request at a time, and a cancel only by the requester while fresh", async () => {
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await expect(as(A.second, (c) => ask(c, A.second))).rejects.toThrow(
      /tenant_shred_request_one_open/,
    );
    await expect(as(A.second, (c) => decide(c, id, "cancelled", A.second))).rejects.toThrow(
      /row-level security/,
    );
    // Who asked and why never change.
    await expect(
      ownerAs(A.first, (c) =>
        c.query("UPDATE tenant_shred_request SET reason = $2 WHERE id = $1", [
          id,
          `${REASON} Changed afterwards.`,
        ]),
      ),
    ).rejects.toThrow(/requester and reason never change/);
    await as(A.first, (c) => decide(c, id, "cancelled", A.first));
  });

  it("lapses after 7 days: no approval, and another holder may withdraw it", async () => {
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await ownerAs(A.first, async (c) => {
      await c.query(
        "ALTER TABLE tenant_shred_request DISABLE TRIGGER tenant_shred_request_guard, NO FORCE ROW LEVEL SECURITY",
      );
      await c.query(
        "UPDATE tenant_shred_request SET requested_at = now() - interval '8 days' WHERE id = $1",
        [id],
      );
      await c.query(
        "ALTER TABLE tenant_shred_request ENABLE TRIGGER tenant_shred_request_guard, FORCE ROW LEVEL SECURITY",
      );
    });
    await expect(as(A.second, (c) => decide(c, id, "shredding", A.second))).rejects.toThrow(
      /row-level security/,
    );
    await as(A.second, async (c) =>
      expect((await decide(c, id, "cancelled", A.second)).rowCount).toBe(1),
    );
  });

  it("refuses a refusal by the requester, without a reason or a late one, and any change after it (migration 0130)", async () => {
    const refuse = (c: pg.PoolClient, id: string, who: string, reason: string | null) =>
      c.query(
        "UPDATE tenant_shred_request SET status = 'refused', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1",
        [id, who, reason],
      );
    const id = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await expect(
      as(A.first, (c) => refuse(c, id, A.first, "Not agreed by the board yet")),
    ).rejects.toThrow(/row-level security/);
    await expect(as(A.second, (c) => refuse(c, id, A.second, null))).rejects.toThrow(
      /tenant_shred_request_refusal/,
    );
    await expect(as(A.second, (c) => refuse(c, id, A.second, "Too short"))).rejects.toThrow(
      /tenant_shred_request_refusal/,
    );
    // A reason belongs to a refusal only.
    await expect(
      as(A.first, (c) =>
        c.query(
          "UPDATE tenant_shred_request SET status = 'cancelled', decided_by = $2, decided_at = now(), decision_reason = 'Changed my mind about it' WHERE id = $1",
          [id, A.first],
        ),
      ),
    ).rejects.toThrow(/decided shred request never changes/);
    await as(A.second, async (c) =>
      expect((await refuse(c, id, A.second, "Not agreed by the board yet")).rowCount).toBe(1),
    );
    // Refused is final: no longer reached by the decide policy, by the app or the owner.
    expect((await as(A.second, (c) => decide(c, id, "shredding", A.second))).rowCount).toBe(0);
    expect((await ownerAs(A.second, (c) => decide(c, id, "shredding", A.second))).rowCount).toBe(0);
    // A refused request is not open: another may be made.
    const next = await as(A.first, async (c) => (await ask(c, A.first)).rows[0]?.id ?? "");
    await ownerAs(A.first, async (c) => {
      await c.query(
        "ALTER TABLE tenant_shred_request DISABLE TRIGGER tenant_shred_request_guard, NO FORCE ROW LEVEL SECURITY",
      );
      await c.query(
        "UPDATE tenant_shred_request SET requested_at = now() - interval '8 days' WHERE id = $1",
        [next],
      );
      await c.query(
        "ALTER TABLE tenant_shred_request ENABLE TRIGGER tenant_shred_request_guard, FORCE ROW LEVEL SECURITY",
      );
    });
    // A lapsed request is withdrawn, never refused.
    await expect(
      as(A.second, (c) => refuse(c, next, A.second, "Not agreed by the board yet")),
    ).rejects.toThrow(/row-level security/);
    await as(A.second, (c) => decide(c, next, "cancelled", A.second));
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
  it("refuses the same person twice, an approver other than the issuer, the unentitled and a half-written signature", async () => {
    await expect(as(A.second, (c) => certificate(c, A.second, A.second))).rejects.toThrow(
      /destruction_certificate_two_people/,
    );
    await expect(as(A.first, (c) => certificate(c, A.first, A.second))).rejects.toThrow(
      /row-level security/,
    );
    await expect(as(A.noRetention, (c) => certificate(c, A.first, A.noRetention))).rejects.toThrow(
      /row-level security/,
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
