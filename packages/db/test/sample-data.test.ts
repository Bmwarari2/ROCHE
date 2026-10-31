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
    // Soft-deleting a sample person does not let a real one in: the open batch decides.
    await ownerDb((c) =>
      c.query("UPDATE person SET deleted_at = now() WHERE sample_batch_id = $1", [batch]),
    );
    await expect(ownerDb(addRealPerson)).rejects.toThrow(/remove_sample_data_first/);
    await asOwner(remove(batch));
  });

  it("never turns a person between real and sample, nor adds one to a removed batch", async () => {
    const batch = await asOwner((c) => loadBatch(c, 1));
    await expect(
      ownerDb((c) =>
        c.query(
          "UPDATE person SET is_sample = false, sample_batch_id = NULL WHERE sample_batch_id = $1",
          [batch],
        ),
      ),
    ).rejects.toThrow(/sample_flag_fixed/);
    await asOwner(remove(batch));
    await expect(
      asOwner((c) =>
        c.query(
          `INSERT INTO person (location_id, status, nhs_number, given_name, family_name,
                               date_of_birth, allergy_status, is_sample, sample_batch_id)
           VALUES ($1, 'active', $2, 'Sam', 'Example', '1940-01-01', 'unknown', true, $3)`,
          [C.location, nextNhs(), batch],
        ),
      ),
    ).rejects.toThrow(/nothing_to_remove/);
  });

  it("keeps one batch at a time", async () => {
    const batch = await asOwner((c) => loadBatch(c, 1));
    await expect(asOwner((c) => loadBatch(c, 1))).rejects.toThrow(/sample_batch_one_open_key/);
    await asOwner(remove(batch));
  });

  it("removes a whole batch through the function only, audited, and leaves every other organisation's rows", async () => {
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
    const left = await ownerDb((c) =>
      c.query<{ n: number }>("SELECT count(*)::int AS n FROM person WHERE sample_batch_id = $1", [
        batch,
      ]),
    );
    expect(left.rows).toEqual([{ n: 0 }]);
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
    expect(audit.rows).toEqual([{ actor: C.owner, scope: { people: 3, records: {} } }]);
  });

  it("removes what staff recorded while practising, and waits only for an active legal hold", async () => {
    const batch = await asOwner((c) => loadBatch(c, 2));
    const people = await ownerDb((c) =>
      c.query<{ id: string }>("SELECT id FROM person WHERE sample_batch_id = $1 ORDER BY id", [
        batch,
      ]),
    );
    const [ada, ben] = people.rows.map((r) => r.id);
    await ownerDb(async (c) => {
      await c.query(
        "INSERT INTO allergy (person_id, substance, severity) VALUES ($1, 'Practice substance', 'mild')",
        [ada],
      );
      await c.query(
        `INSERT INTO contact (person_id, role, given_name, family_name, is_next_of_kin)
         VALUES ($1, 'next_of_kin', 'Eve', 'Example', true)`,
        [ada],
      );
      await c.query(
        `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
         VALUES ($1, $2, now() - interval '3 hours', 'other', 'Practice note.')`,
        [ben, C.location],
      );
      await c.query(
        `INSERT INTO observation (person_id, location_id, chart, values, occurred_at)
         VALUES ($1, $2, 'fluid_intake', '{"ml":200}', now() - interval '3 hours')`,
        [ben, C.location],
      );
    });
    const hold = await ownerDb((c) =>
      c.query<{ id: string }>(
        "INSERT INTO legal_hold (person_id, reason) VALUES ($1, 'Practice hold') RETURNING id",
        [ada],
      ),
    );
    await expect(asOwner(remove(batch))).rejects.toThrow(/held/);
    const kept = await ownerDb((c) =>
      c.query<{ n: number }>("SELECT count(*)::int AS n FROM care_note WHERE person_id = $1", [
        ben,
      ]),
    );
    expect(kept.rows).toEqual([{ n: 1 }]);
    await ownerDb((c) =>
      c.query("UPDATE legal_hold SET released_at = now() WHERE id = $1", [hold.rows[0]?.id]),
    );
    const { rows } = await asOwner(remove(batch));
    expect(rows).toEqual([{ removed: 2 }]);
    for (const table of ["allergy", "contact", "care_note", "observation", "legal_hold"]) {
      const left = await ownerDb((c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE person_id = ANY ($1)`,
          [[ada, ben]],
        ),
      );
      expect(left.rows, table).toEqual([{ n: 0 }]);
    }
    const audit = await ownerDb((c) =>
      c.query(
        `SELECT scope FROM audit_event
          WHERE action = 'platform.onboarding.sample_removed' AND resource_id = $1`,
        [batch],
      ),
    );
    expect(audit.rows).toEqual([
      {
        scope: {
          people: 2,
          records: { allergy: 1, contact: 1, care_note: 1, observation: 1, legal_hold: 1 },
        },
      },
    ]);
    // The append-only tables still refuse a delete everywhere else, even with the removal's mark.
    await expect(
      ownerDb(
        (c) =>
          c.query(
            `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
           SELECT id, location_id, now(), 'other', 'Real note' FROM person
            WHERE tenant_id = $1 LIMIT 1`,
            [TENANT_A],
          ),
        TENANT_A,
      ),
    ).resolves.toBeDefined();
    await expect(
      ownerDb(async (c) => {
        await c.query("SELECT set_config('app.sample_removal', 'on', true)");
        return c.query("DELETE FROM care_note");
      }, TENANT_A),
    ).rejects.toThrow(/append-only/);
  });

  it("removes nothing while a record outside the people's own still refers to them", async () => {
    const batch = await asOwner((c) => loadBatch(c, 1));
    await ownerDb(async (c) => {
      const doc = await c.query<{ id: string }>(
        `INSERT INTO document (category, title, retention_class, storage_key, content_type,
                               size_bytes, sha256, person_id)
         SELECT 'person_document', 'Practice letter', 'care_record', 'k-sample',
                'application/pdf', 10, repeat('a', 64), id
           FROM person WHERE sample_batch_id = $1 RETURNING id`,
        [batch],
      );
      await c.query(
        `INSERT INTO escalation_policy_link (tool_key, band, title, document_id)
         VALUES ('news2', 'high', 'Practice policy', $1)`,
        [doc.rows[0]?.id],
      );
    });
    await expect(asOwner(remove(batch))).rejects.toThrow(/referenced_by_other_records/);
    const left = await ownerDb((c) =>
      c.query<{ removed_at: Date | null }>("SELECT removed_at FROM sample_batch WHERE id = $1", [
        batch,
      ]),
    );
    expect(left.rows).toEqual([{ removed_at: null }]);
    await ownerDb((c) => c.query("DELETE FROM escalation_policy_link"));
    await expect(asOwner(remove(batch))).resolves.toBeDefined();
  });

  it("tells the guards only yes or no, for the whole organisation whatever the caller's scope", async () => {
    const read = () =>
      inContext(app(), ctx(TENANT_C, C.carer, "none"), (c) =>
        c.query<{ has_sample: boolean; has_real: boolean }>("SELECT * FROM app.sample_people()"),
      );
    expect((await read()).rows).toEqual([{ has_sample: false, has_real: false }]);
    const batch = await asOwner((c) => loadBatch(c, 1));
    expect((await read()).rows).toEqual([{ has_sample: true, has_real: false }]);
    await asOwner(remove(batch));
  });

  it("counts a soft-deleted real person, and refuses to guess under REPEATABLE READ", async () => {
    const client = await db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [TENANT_C],
      );
      await expect(addRealPerson(client as unknown as pg.PoolClient)).rejects.toThrow(
        /READ COMMITTED or SERIALIZABLE/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await ownerDb(addRealPerson);
    await ownerDb((c) => c.query("UPDATE person SET deleted_at = now() WHERE NOT is_sample"));
    await expect(asOwner((c) => loadBatch(c))).rejects.toThrow(/real_people_exist/);
  });
});

/**
 * Tables that refer to people but stop a removal rather than go with it: records outside a
 * person's own (an organisation's escalation policy, a downtime pack, an outage) and the sample
 * batch itself. A new table that refers to a person must be added to app.sample_removal_tables()
 * or here, deliberately.
 */
// A data protection complaint about a sample person is a real complaint record (migration 0082):
// its foreign key stops the removal rather than the complaint going with the sample.
const BLOCKS_REMOVAL = ["downtime_pack", "dp_complaint", "escalation_policy_link", "outage"];

describe("hazard HZ-072 the removal list keeps in step with the schema (migration 0069)", () => {
  const owner = () => db.pool("harbour_owner");
  const listed = async () =>
    (await owner().query<{ t: string[] }>("SELECT app.sample_removal_tables() AS t")).rows[0]?.t ??
    [];

  it("covers every table that refers to a person, or says it stops removal", async () => {
    const allow = new Set(await listed());
    const { rows } = await owner().query<{ name: string }>(
      `SELECT DISTINCT c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'person'
          AND (EXISTS (SELECT 1 FROM pg_constraint f
                        WHERE f.contype = 'f' AND f.conrelid = c.oid
                          AND f.confrelid = 'public.person'::regclass)
               OR EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'person_id'
                             AND NOT a.attisdropped))
        ORDER BY 1`,
    );
    expect(
      rows.map((r) => r.name).filter((t) => !allow.has(t) && !BLOCKS_REMOVAL.includes(t)),
    ).toEqual([]);
    // And whatever refers to a listed table is listed too, or stops removal.
    const refs = await owner().query<{ child: string; parent: string }>(
      `SELECT f.conrelid::regclass::text AS child, f.confrelid::regclass::text AS parent
         FROM pg_constraint f WHERE f.contype = 'f' AND f.conrelid <> f.confrelid`,
    );
    expect(
      refs.rows
        .filter((r) => allow.has(r.parent) && !allow.has(r.child) && r.child !== "person")
        .filter((r) => !BLOCKS_REMOVAL.includes(r.child)),
    ).toEqual([]);
  });

  it("lists children before parents, and only tables that exist", async () => {
    const order = await listed();
    const refs = await owner().query<{ child: string; parent: string }>(
      `SELECT f.conrelid::regclass::text AS child, f.confrelid::regclass::text AS parent
         FROM pg_constraint f WHERE f.contype = 'f' AND f.conrelid <> f.confrelid`,
    );
    const late = refs.rows.filter(
      (r) =>
        order.includes(r.child) &&
        order.includes(r.parent) &&
        order.indexOf(r.child) > order.indexOf(r.parent),
    );
    expect(late).toEqual([]);
    const { rows } = await owner().query<{ name: string }>(
      "SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY ($1)",
      [order],
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...order].sort());
  });

  it("grants harbour_sample_owner DELETE on exactly the listed tables and person", async () => {
    const { rows } = await owner().query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.role_table_grants
        WHERE grantee = 'harbour_sample_owner' AND privilege_type = 'DELETE' ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([...(await listed()), "person"].sort());
  });
});
