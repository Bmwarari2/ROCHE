import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Device signing keys (migration 0153; ADR-0084; Phase 2 slice 70): a member enrols only their own
 * key, on a device bound to them; another member reads only their own; the system's view (the API
 * verifying a witness's signature) reads all; another tenant reads none; nothing changes or goes.
 */

let db: TestDatabase;
const a = ids.a;
const DEVICE = "0199d000-0000-4000-8000-0000000000e1";
// An invented uncompressed P-256 point's shape: 65 bytes, base64.
const KEY = `B${"A".repeat(85)}A=`;

const app = () => db.pool("harbour_app");
const as = <T>(user: string | null, scope: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, user, scope as "tenant"), fn);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
    c.query("INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2), ($1, $3)", [
      DEVICE,
      a.carer,
      a.manager,
    ]),
  );
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("a member's signing key for a device (ADR-0084)", () => {
  it("enrols only the member's own key, on a device bound to them", async () => {
    await as(a.carer, "tenant", (c) =>
      c.query(
        "INSERT INTO member_device_key (device_id, tenant_user_id, public_key) VALUES ($1, $2, $3)",
        [DEVICE, a.carer, KEY],
      ),
    );
    await expect(
      as(a.carer, "tenant", (c) =>
        c.query(
          "INSERT INTO member_device_key (device_id, tenant_user_id, public_key) VALUES ($1, $2, $3)",
          [DEVICE, a.manager, KEY],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(a.carer, "tenant", (c) =>
        c.query(
          "INSERT INTO member_device_key (device_id, tenant_user_id, public_key) VALUES ($1, $2, 'not a key')",
          [DEVICE, a.carer],
        ),
      ),
    ).rejects.toThrow(/member_device_key_shape/);
  });

  it("is read by its member and the system's view, never by another member or tenant", async () => {
    const count = (user: string | null, scope: string, tenant = TENANT_A) =>
      inContext(app(), ctx(tenant, user, scope as "tenant"), async (c) =>
        Number((await c.query("SELECT count(*) FROM member_device_key")).rows[0].count),
      );
    expect(await count(a.carer, "assigned")).toBe(1);
    expect(await count(a.manager, "tenant")).toBe(0);
    expect(await count(null, "tenant")).toBe(1);
    expect(await count(ids.b.manager, "tenant", TENANT_B)).toBe(0);
  });

  it("never changes or goes: a new PIN is a new key", async () => {
    await expect(
      as(null, "tenant", (c) => c.query("UPDATE member_device_key SET public_key = public_key")),
    ).rejects.toThrow();
    await expect(
      as(null, "tenant", (c) => c.query("DELETE FROM member_device_key")),
    ).rejects.toThrow();
  });
});
