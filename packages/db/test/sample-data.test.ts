import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * Sample data mode in the database (platform-completions.md rules 29 to 32; migration 0069;
 * hazards HZ-072 and HZ-011): a batch is loaded in its loader's name by a holder of
 * platform.onboarding.manage, only while no real person exists; a real person waits until it has
 * gone, by every path; a person never changes between real and sample; and only
 * `app.remove_sample_batch` removes a batch, whole or not at all, leaving every real row.
 */

let db: TestDatabase;
const TENANT_C = "0193c000-0000-7000-8000-00000000000c";
const C = {
  location: "0193c000-0000-7000-8000-000000000101",
  owner: "0193c000-0000-7000-8000-000000000201",
  carer: "0193c000-0000-7000-8000-000000000202",
  roleOnboarder: "0193c000-0000-7000-8000-000000000301",
  roleCarer: "0193c000-0000-7000-8000-000000000302",
};
const app = () => db.pool("harbour_app");
const as =
  (userId: string, tenant = TENANT_C) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(tenant, userId, "tenant"), fn);
const asOwner = as(C.owner);
const asCarer = as(C.carer);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>, tenant = TENANT_C) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);

let nhs = 0;
/** A 999-range NHS number with a valid check digit, distinct each call. */
function nextNhs(): string {
  for (;;) {
    nhs += 1;
    const body = `999${String(6100000 + nhs).slice(-6)}`;
    const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
    const check = 11 - (sum % 11);
    if (check === 10) continue;
    return `${body}${check === 11 ? 0 : check}`;
  }
}

async function loadBatch(c: pg.PoolClient, people = 2): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    "INSERT INTO sample_batch (people) VALUES ($1) RETURNING id",
    [people],
  );
  const batch = rows[0]?.id ?? "";
  for (let i = 0; i < people; i += 1) {
    await c.query(
      `INSERT INTO person (location_id, status, nhs_number, given_name, family_name, date_of_birth,
                           allergy_status, is_sample, sample_batch_id)
       VALUES ($1, 'active', $2, 'Sam', 'Example', '1940-01-01', 'unknown', true, $3)`,
      [C.location, nextNhs(), batch],
    );
  }
  return batch;
}

function addRealPerson(c: pg.PoolClient) {
  return c.query(
    `INSERT INTO person (location_id, status, nhs_number, given_name, family_name, date_of_birth,
                         allergy_status)
     VALUES ($1, 'active', $2, 'Rae', 'Example', '1945-05-05', 'unknown')`,
    [C.location, nextNhs()],
  );
}

const remove = (batch: string) => (c: pg.PoolClient) =>
  c.query<{ removed: number }>("SELECT app.remove_sample_batch($1, 'req-test') AS removed", [
    batch,
  ]);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO tenant (id, name, legal_name, legal_form, status)
       VALUES ($1, 'Third Provider', 'Third Provider Ltd', 'limited_company', 'onboarding')`,
      [TENANT_C],
    );
    await c.query(
      "INSERT INTO location (id, name, regulator_location_id) VALUES ($1, 'Hill House', '1-000000003')",
      [C.location],
    );
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-c-owner', 'Oli Owner', 'oli.owner@example.invalid', 'active'),
         ($2, 'auth-c-carer', 'Cal Carer', 'cal.carer@example.invalid', 'active')`,
      [C.owner, C.carer],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'onboarder', 'Onboarder', 'tenant', '{platform.onboarding.manage,people.person.read}'),
         ($2, 'carer', 'Carer', 'tenant', '{people.person.read}')`,
      [C.roleOnboarder, C.roleCarer],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2), ($3, $4)",
      [C.owner, C.roleOnboarder, C.carer, C.roleCarer],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-072 sample data is never mixed with real people (migration 0069)", () => {
  it("loads a batch only for a holder of platform.onboarding.manage, in their own name", async () => {
    await expect(asCarer((c) => loadBatch(c))).rejects.toThrow(/row-level security/);
    await expect(
      asOwner((c) =>
        c.query("INSERT INTO sample_batch (people, loaded_by) VALUES (1, $1)", [C.carer]),
      ),
    ).rejects.toThrow(/row-level security/);
    const batch = await asOwner((c) => loadBatch(c));
    const { rows } = await ownerDb((c) =>
      c.query("SELECT loaded_by, people FROM sample_batch WHERE id = $1", [batch]),
    );
    expect(rows).toEqual([{ loaded_by: C.owner, people: 2 }]);
    await expect(asOwner(remove(batch))).resolves.toBeDefined();
  });

  it("refuses sample people where real people exist, and real people while sample data remains", async () => {
    // Organisation A has real people.
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO person (location_id, status, nhs_number, given_name, family_name,
                               date_of_birth, allergy_status, is_sample)
           VALUES ($1, 'active', $2, 'Sam', 'Example', '1940-01-01', 'unknown', true)`,
          [ids.a.locationNorth, nextNhs()],
        ),
      ),
    ).rejects.toThrow(/person_sample|real_people_exist/);
    const batch = await asOwner((c) => loadBatch(c));
    // Every creation path writes a person row, whichever role writes it.
    await expect(asOwner(addRealPerson)).rejects.toThrow(/remove_sample_data_first/);
    await expect(ownerDb(addRealPerson)).rejects.toThrow(/remove_sample_data_first/);
    await asOwner(remove(batch));
    await ownerDb(addRealPerson);
    await expect(asOwner((c) => loadBatch(c))).rejects.toThrow(/real_people_exist/);
    await ownerDb((c) => c.query("UPDATE person SET deleted_at = now()"));
  });

  it("never turns a person between real and sample", async () => {
    const batch = await asOwner((c) => loadBatch(c, 1));
    await expect(
      ownerDb((c) =>
        c.query(
          "UPDATE person SET is_sample = false, sample_batch_id = NULL WHERE sample_batch_id = $1",
          [batch],
        ),
      ),
    ).rejects.toThrow(/sample_flag_fixed/);
    await expect(
      ownerDb((c) => c.query("UPDATE person SET is_sample = true WHERE sample_batch_id IS NULL")),
    ).rejects.toThrow(/sample_flag_fixed|person_sample/);
    await asOwner(remove(batch));
  });

  it("removes a whole batch through the function only, audited, and leaves every real row", async () => {
    const before = await ownerDb((c) =>
      c.query<{ n: number }>("SELECT count(*)::int AS n FROM person WHERE NOT is_sample"),
    );
    const otherBefore = await ownerDb(
      (c) => c.query<{ n: number }>("SELECT count(*)::int AS n FROM person"),
      TENANT_A,
    );
    const batch = await asOwner((c) => loadBatch(c, 3));
    await expect(asOwner((c) => c.query("DELETE FROM person"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asOwner((c) => c.query("DELETE FROM sample_batch"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asCarer(remove(batch))).rejects.toThrow(/missing_permission/);
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.manager, "tenant"), remove(batch)),
    ).rejects.toThrow(/missing_permission|nothing_to_remove/);
    const { rows } = await asOwner(remove(batch));
    expect(rows).toEqual([{ removed: 3 }]);
    await expect(asOwner(remove(batch))).rejects.toThrow(/nothing_to_remove/);
    const after = await ownerDb((c) =>
      c.query<{ sample: number; real: number }>(
        `SELECT count(*) FILTER (WHERE is_sample)::int AS sample,
                count(*) FILTER (WHERE NOT is_sample)::int AS real FROM person`,
      ),
    );
    expect(after.rows).toEqual([{ sample: 0, real: before.rows[0]?.n }]);
    const other = await ownerDb(
      (c) => c.query<{ n: number }>("SELECT count(*)::int AS n FROM person"),
      TENANT_A,
    );
    expect(other.rows).toEqual(otherBefore.rows);
    const audit = await ownerDb((c) =>
      c.query(
        `SELECT actor_tenant_user_id AS actor, scope FROM audit_event
          WHERE action = 'platform.onboarding.sample_removed' AND resource_id = $1`,
        [batch],
      ),
    );
    expect(audit.rows).toEqual([{ actor: C.owner, scope: { people: 3 } }]);
  });

  it("removes nothing while a person in the batch is under a legal hold", async () => {
    const batch = await asOwner((c) => loadBatch(c, 2));
    const holdId = await ownerDb(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO legal_hold (person_id, reason)
         SELECT id, 'Practice hold' FROM person WHERE sample_batch_id = $1 LIMIT 1 RETURNING id`,
        [batch],
      );
      return rows[0]?.id;
    });
    await expect(asOwner(remove(batch))).rejects.toThrow(/held/);
    const left = await ownerDb((c) =>
      c.query<{ n: number }>("SELECT count(*)::int AS n FROM person WHERE sample_batch_id = $1", [
        batch,
      ]),
    );
    expect(left.rows).toEqual([{ n: 2 }]);
    // A released hold is still a record about the person, so the batch stays until it goes too.
    await ownerDb((c) =>
      c.query("UPDATE legal_hold SET released_at = now() WHERE id = $1", [holdId]),
    );
    await expect(asOwner(remove(batch))).rejects.toThrow(/referenced_by_real_records/);
  });

  it("keeps one batch at a time, and removes nothing while another record refers to it", async () => {
    // The batch from the legal hold case is still in place.
    const { rows } = await ownerDb((c) =>
      c.query<{ id: string }>("SELECT id FROM sample_batch WHERE removed_at IS NULL"),
    );
    const batch = rows[0]?.id ?? "";
    await expect(asOwner((c) => loadBatch(c, 1))).rejects.toThrow(/sample_batch_one_open_key/);
    await ownerDb((c) =>
      c.query(
        `INSERT INTO allergy (person_id, substance, severity)
         SELECT id, 'Practice substance', 'mild' FROM person WHERE sample_batch_id = $1`,
        [batch],
      ),
    );
    await expect(asOwner(remove(batch))).rejects.toThrow(/referenced_by_real_records/);
    const left = await ownerDb((c) =>
      c.query<{ removed_at: Date | null }>("SELECT removed_at FROM sample_batch WHERE id = $1", [
        batch,
      ]),
    );
    expect(left.rows).toEqual([{ removed_at: null }]);
  });

  it("counts the whole organisation's sample and real people whatever the caller's scope", async () => {
    const counts = await inContext(app(), ctx(TENANT_C, C.carer, "none"), (c) =>
      c.query<{ sample_count: string; real_count: string }>("SELECT * FROM app.sample_people()"),
    );
    expect(counts.rows).toEqual([{ sample_count: "2", real_count: "0" }]);
  });
});
