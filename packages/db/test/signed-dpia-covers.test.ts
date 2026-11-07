import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * H-1555 (migration 0153): `app.signed_dpia_covers(flag)` answers, for whoever clocks in or checks
 * in, whether their own organisation's signed DPIA lists an employee-monitoring flag. It runs as
 * harbour_platform_definer, which row-level security binds only through `tenant_isolation`, so
 * these tests prove it never answers from another organisation's DPIA, and that only the signed
 * version counts (a superseded one that listed the flag does not).
 */

const FLAG = "scheduling.clock.location_evidence";

let db: TestDatabase;

const asOwner = <T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);

/** What the definer answers for a member of tenant A or B, as the API asks it. */
const covers = (tenant: string, user: string, flag: string = FLAG) =>
  inContext(db.pool("harbour_app"), ctx(tenant, user, "tenant"), async (c) => {
    const { rows } = await c.query<{ id: string | null }>(
      "SELECT app.signed_dpia_covers($1) AS id",
      [flag],
    );
    return rows[0]?.id ?? null;
  });

const basis = (features: string[]) =>
  JSON.stringify({ purposes: [], subProcessors: [], dataCategories: [], features });

/** One DPIA version, signed or superseded, listing these features (invented signer and preparer). */
async function dpiaVersion(
  tenant: string,
  signer: string,
  version: number,
  status: "signed" | "superseded",
  features: string[],
): Promise<string> {
  return asOwner(tenant, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO dpia (dpia_version, status, prefill, prepared_by, version_sha256, prepared_at,
                         signed_by, signed_at, typed_name, statement, basis)
       VALUES ($1, $2, '{}'::jsonb, ARRAY[$3::uuid], repeat('a', 64), now(), $4, now(),
               'Example Signer', 'Signed for the test', $5::jsonb) RETURNING id`,
      [version, status, randomUUID(), signer, basis(features)],
    );
    return rows[0]?.id as string;
  });
}

const clear = async () => {
  await asOwner(TENANT_A, (c) => c.query("DELETE FROM dpia"));
  await asOwner(TENANT_B, (c) => c.query("DELETE FROM dpia"));
};

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard H-1555 the signed-DPIA definer answers only for the caller's organisation", () => {
  it("finds nothing for tenant A when only tenant B's signed DPIA covers the flag", async () => {
    await clear();
    const bSigned = await dpiaVersion(TENANT_B, ids.b.manager, 1, "signed", [FLAG]);
    expect(await covers(TENANT_A, ids.a.carer)).toBeNull();
    // The control: tenant B's own member is answered from it.
    expect(await covers(TENANT_B, ids.b.manager)).toBe(bSigned);
  });

  it("answers tenant A from its own signed DPIA, which does not cover the flag, not tenant B's", async () => {
    await clear();
    await dpiaVersion(TENANT_A, ids.a.manager, 1, "signed", ["module.residential"]);
    await dpiaVersion(TENANT_B, ids.b.manager, 1, "signed", ["module.residential", FLAG]);
    expect(await covers(TENANT_A, ids.a.carer)).toBeNull();
    expect(await covers(TENANT_A, ids.a.carer, "module.residential")).not.toBeNull();
  });

  it("never counts a superseded version that listed the flag", async () => {
    await clear();
    await dpiaVersion(TENANT_A, ids.a.manager, 1, "superseded", ["module.residential", FLAG]);
    const v2 = await dpiaVersion(TENANT_A, ids.a.manager, 2, "signed", ["module.residential"]);
    expect(await covers(TENANT_A, ids.a.carer)).toBeNull();
    expect(await covers(TENANT_A, ids.a.carer, "module.residential")).toBe(v2);
  });

  it("returns only an id: the caller still cannot read the DPIA itself", async () => {
    await clear();
    await dpiaVersion(TENANT_A, ids.a.manager, 1, "signed", [FLAG]);
    const visible = await inContext(
      db.pool("harbour_app"),
      ctx(TENANT_A, ids.a.carer, "tenant"),
      async (c) => (await c.query("SELECT id FROM dpia")).rows.length,
    );
    expect(visible).toBe(0);
  });
});
