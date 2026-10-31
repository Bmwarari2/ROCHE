import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The import wizard's tables (PLAT-014; platform.md rules 18 to 26; migration 0088; hazards HZ-130
 * and HZ-011): a batch, its staged rows and its commit record are reached only by a member holding
 * platform.import.run across the organisation in a request scoped to the whole organisation, or by
 * a job with no member; never by another organisation. Staged rows are insert-only and go when the
 * batch closes; the guard moves a batch forward only; `app.undo_import_batch` removes a commit's
 * people whole or not at all, only while they are unchanged and nothing refers to them.
 */

let db: TestDatabase;
const app = () => db.pool("harbour_app");
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>, tenant = TENANT_A) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);

/** Organisation A: an importer across it, one at North House only, and a manager without imports. */
const A = {
  importer: ids.a.manager,
  northImporter: ids.a.northManager,
  noImport: ids.a.carer,
  roleImporter: "0193a000-0000-7000-8000-000000000601",
  roleNorthImporter: "0193a000-0000-7000-8000-000000000602",
  roleReader: "0193a000-0000-7000-8000-000000000603",
};
const B = { roleImporter: "0193b000-0000-7000-8000-000000000601" };
const IMPORT = "{platform.import.run,people.person.create,people.person.read}";

const asImporter = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, A.importer, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
const asOtherOrganisation = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), fn);

let nhs = 0;
/** A 999-range NHS number with a valid check digit, distinct each call. */
function nextNhs(): string {
  for (;;) {
    nhs += 1;
    const body = `999${String(6200000 + nhs).slice(-6)}`;
    const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
    const check = 11 - (sum % 11);
    if (check === 10) continue;
    return `${body}${check === 11 ? 0 : check}`;
  }
}

/** Uploads a staged batch of `rows` rows at North House as the importer. */
async function upload(c: pg.PoolClient, rows = 2, expiresIn = "7 days"): Promise<string> {
  const { rows: made } = await c.query<{ id: string }>(
    `INSERT INTO import_batch (record_type, location_id, row_count, expires_at)
     VALUES ('people', $1, $2, now() + $3::interval) RETURNING id`,
    [ids.a.locationNorth, rows, expiresIn],
  );
  const batch = made[0]?.id ?? "";
  for (let n = 1; n <= rows; n += 1) {
    await c.query("INSERT INTO import_row (batch_id, row_number, cells) VALUES ($1, $2, $3)", [
      batch,
      n,
      JSON.stringify({ given_name: "Ida", family_name: "Example", date_of_birth: "01/02/1940" }),
    ]);
  }
  return batch;
}

const dryRun =
  (batch: string, me: string = A.importer) =>
  (c: pg.PoolClient) =>
    c.query(
      `UPDATE import_batch SET dry_run_at = now(), dry_run_by = $2, dry_run_errors = 0,
       dry_run_warnings = 0 WHERE id = $1`,
      [batch, me],
    );

/** Commits a dry-run batch as the importer: people created, the batch closed, the record kept. */
async function commit(c: pg.PoolClient, batch: string, people = 2): Promise<string[]> {
  const created: string[] = [];
  for (let n = 0; n < people; n += 1) {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO person (location_id, status, nhs_number, given_name, family_name, date_of_birth)
       VALUES ($1, 'active', $2, 'Ida', 'Example', '1940-02-01') RETURNING id`,
      [ids.a.locationNorth, nextNhs()],
    );
    created.push(rows[0]?.id ?? "");
  }
  await c.query(
    "UPDATE import_batch SET status = 'committed', closed_at = now(), closed_by = $2 WHERE id = $1",
    [batch, A.importer],
  );
  await c.query(
    "INSERT INTO import_commit (batch_id, record_ids, record_count) VALUES ($1, $2, $3)",
    [batch, created, created.length],
  );
  return created;
}

const undo = (batch: string) => (c: pg.PoolClient) =>
  c.query<{ removed: number }>("SELECT app.undo_import_batch($1, 'req-test') AS removed", [batch]);

const stagedRows = (batch: string) =>
  ownerDb(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM import_row WHERE batch_id = $1",
      [batch],
    );
    return rows[0]?.n;
  });

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'importer', 'Importer', 'tenant', $4),
         ($2, 'north_importer', 'North importer', 'location', $4),
         ($3, 'reader', 'Reader', 'tenant', '{people.person.read,people.person.create}')`,
      [A.roleImporter, A.roleNorthImporter, A.roleReader, IMPORT],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, $5), ($6, $7, NULL)`,
      [
        A.importer,
        A.roleImporter,
        A.northImporter,
        A.roleNorthImporter,
        ids.a.locationNorth,
        A.noImport,
        A.roleReader,
      ],
    );
  });
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'importer', 'Importer', 'tenant', $2)`,
      [B.roleImporter, IMPORT],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      ids.b.manager,
      B.roleImporter,
    ]);
  }, TENANT_B);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-130 hazard HZ-011 the import tables (migration 0088)", () => {
  it("lets only a holder across the organisation upload, in their own name", async () => {
    const batch = await asImporter((c) => upload(c));
    expect(await stagedRows(batch)).toBe(2);
    const { rows } = await ownerDb((c) =>
      c.query("SELECT uploaded_by, status FROM import_batch WHERE id = $1", [batch]),
    );
    expect(rows).toEqual([{ uploaded_by: A.importer, status: "staged" }]);
    // Someone else's name, or a batch that is not staged, is refused.
    await expect(
      asImporter((c) =>
        c.query(
          `INSERT INTO import_batch (record_type, location_id, row_count, expires_at, uploaded_by)
           VALUES ('people', $1, 1, now() + interval '1 day', $2)`,
          [ids.a.locationNorth, A.noImport],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asImporter((c) =>
        c.query(
          `INSERT INTO import_batch (record_type, location_id, row_count, expires_at, status,
                                     closed_at, closed_by)
           VALUES ('people', $1, 1, now() + interval '1 day', 'committed', now(), $2)`,
          [ids.a.locationNorth, A.importer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("hazard HZ-130 refuses a holder at one home only, and a member without the permission, whatever their scope says", async () => {
    const batch = await asImporter((c) => upload(c, 1));
    for (const [who, scope, locations] of [
      [A.northImporter, "locations", [ids.a.locationNorth]],
      // Even a request claiming the whole organisation: the holding is checked, not the claim.
      [A.northImporter, "tenant", []],
      [A.noImport, "tenant", []],
    ] as const) {
      const as = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
        inContext(app(), ctx(TENANT_A, who, scope, locations), fn);
      const seen = await as(async (c) => {
        const b = await c.query("SELECT id FROM import_batch");
        const r = await c.query("SELECT id FROM import_row");
        const m = await c.query("SELECT id FROM import_commit");
        return b.rows.length + r.rows.length + m.rows.length;
      });
      expect(seen, `${who} ${scope}`).toBe(0);
      await expect(
        as((c) => upload(c, 1)),
        `${who} ${scope}`,
      ).rejects.toThrow(/row-level security/);
      await expect(
        as((c) =>
          c.query("INSERT INTO import_row (batch_id, row_number, cells) VALUES ($1, 9, '{}')", [
            batch,
          ]),
        ),
      ).rejects.toThrow(/row-level security|foreign key/);
    }
    // The importer in a request scoped to one home sees nothing either.
    const narrowed = await inContext(
      app(),
      ctx(TENANT_A, A.importer, "locations", [ids.a.locationNorth]),
      async (c) => (await c.query("SELECT id FROM import_batch")).rows.length,
    );
    expect(narrowed).toBe(0);
  });

  it("hazard HZ-011 another organisation never sees or writes a batch, a staged row or a commit", async () => {
    const batch = await asImporter((c) => upload(c, 1));
    await asImporter(dryRun(batch));
    await asImporter((c) => commit(c, batch, 1));
    const seen = await asOtherOrganisation(async (c) => ({
      batches: (await c.query("SELECT id FROM import_batch")).rows.length,
      rows: (await c.query("SELECT id FROM import_row")).rows.length,
      commits: (await c.query("SELECT id FROM import_commit")).rows.length,
    }));
    expect(seen).toEqual({ batches: 0, rows: 0, commits: 0 });
    // Pointing at another organisation's batch fails: it is not there to point at.
    await expect(
      asOtherOrganisation((c) =>
        c.query("INSERT INTO import_row (batch_id, row_number, cells) VALUES ($1, 1, '{}')", [
          batch,
        ]),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
    await expect(
      asOtherOrganisation((c) =>
        c.query(
          "INSERT INTO import_commit (batch_id, record_ids, record_count) VALUES ($1, $2, 1)",
          [batch, [ids.a.personAda]],
        ),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
    const updated = await asOtherOrganisation(
      async (c) =>
        (await c.query("UPDATE import_batch SET status = 'discarded' WHERE id = $1", [batch]))
          .rowCount,
    );
    expect(updated).toBe(0);
    await expect(asOtherOrganisation(undo(batch))).rejects.toThrow(/nothing_to_undo/);
  });

  it("keeps staged rows insert-only, by the uploader, into a staged batch", async () => {
    const batch = await asImporter((c) => upload(c, 1));
    await expect(
      asImporter((c) => c.query("UPDATE import_row SET cells = '{}' WHERE batch_id = $1", [batch])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asImporter((c) => c.query("DELETE FROM import_row WHERE batch_id = $1", [batch])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      ownerDb((c) => c.query("UPDATE import_row SET cells = '{}' WHERE batch_id = $1", [batch])),
    ).rejects.toThrow(/append-only|not allowed/);
    await asImporter((c) =>
      c.query(
        "UPDATE import_batch SET status = 'discarded', closed_at = now(), closed_by = $2 WHERE id = $1",
        [batch, A.importer],
      ),
    );
    await expect(
      asImporter((c) =>
        c.query("INSERT INTO import_row (batch_id, row_number, cells) VALUES ($1, 5, '{}')", [
          batch,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("deletes a batch's staged rows in the transaction that commits, discards or expires it", async () => {
    const committed = await asImporter((c) => upload(c));
    await asImporter(dryRun(committed));
    await asImporter((c) => commit(c, committed));
    expect(await stagedRows(committed)).toBe(0);

    const discarded = await asImporter((c) => upload(c));
    await asImporter((c) =>
      c.query(
        "UPDATE import_batch SET status = 'discarded', closed_at = now(), closed_by = $2 WHERE id = $1",
        [discarded, A.importer],
      ),
    );
    expect(await stagedRows(discarded)).toBe(0);

    const expiring = await asImporter((c) => upload(c, 2, "-1 minute"));
    await asSystem((c) =>
      c.query("UPDATE import_batch SET status = 'expired', closed_at = now() WHERE id = $1", [
        expiring,
      ]),
    );
    expect(await stagedRows(expiring)).toBe(0);

    // A rolled-back close keeps them.
    const kept = await asImporter((c) => upload(c));
    await expect(
      asImporter(async (c) => {
        await c.query(
          "UPDATE import_batch SET status = 'discarded', closed_at = now(), closed_by = $2 WHERE id = $1",
          [kept, A.importer],
        );
        throw new Error("rolled back");
      }),
    ).rejects.toThrow(/rolled back/);
    expect(await stagedRows(kept)).toBe(2);
  });

  it("moves a batch forward only, in the member's own name, after a dry run", async () => {
    const batch = await asImporter((c) => upload(c, 1));
    const close = (status: string, by: string | null) => (c: pg.PoolClient) =>
      c.query(
        "UPDATE import_batch SET status = $2, closed_at = now(), closed_by = $3 WHERE id = $1",
        [batch, status, by],
      );
    await expect(asImporter(close("committed", A.importer))).rejects.toThrow(/dry_run_first/);
    await expect(asImporter(close("discarded", A.noImport))).rejects.toThrow(
      /import_closed_own_name/,
    );
    // Not yet expired, and never by a member.
    await expect(asSystem(close("expired", null))).rejects.toThrow(/import_not_expired/);
    await expect(asImporter(close("expired", A.importer))).rejects.toThrow(/import_not_expired/);
    await expect(asImporter(dryRun(batch, A.noImport))).rejects.toThrow(/import_dry_run_own_name/);
    await asImporter(dryRun(batch));
    await expect(
      asImporter((c) =>
        c.query("UPDATE import_batch SET row_count = 9, location_id = $2 WHERE id = $1", [
          batch,
          ids.a.locationSouth,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      ownerDb((c) => c.query("UPDATE import_batch SET row_count = 9 WHERE id = $1", [batch])),
    ).rejects.toThrow(/import_batch_fixed/);
    await asImporter((c) => commit(c, batch, 1));
    await expect(asImporter(close("staged", null))).rejects.toThrow(
      /import_status_forward_only|import_batch_closed|import_batch_closed/,
    );
    await expect(
      asImporter((c) =>
        c.query("UPDATE import_batch SET status = 'undone' WHERE id = $1", [batch]),
      ),
    ).rejects.toThrow(/import_undone_by_function/);
    await expect(asImporter(dryRun(batch))).rejects.toThrow(/import_dry_run_own_name/);
    await expect(
      asImporter((c) => c.query("DELETE FROM import_batch WHERE id = $1", [batch])),
    ).rejects.toThrow(/permission denied/);
  });

  it("records a commit only for a committed batch, in the committer's own name", async () => {
    const batch = await asImporter((c) => upload(c, 1));
    await asImporter(dryRun(batch));
    await expect(
      asImporter((c) =>
        c.query(
          "INSERT INTO import_commit (batch_id, record_ids, record_count) VALUES ($1, $2, 1)",
          [batch, [ids.a.personAda]],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await asImporter((c) => commit(c, batch, 1));
    await expect(
      asImporter((c) =>
        c.query(
          `INSERT INTO import_commit (batch_id, record_ids, record_count, committed_by)
           VALUES ($1, $2, 1, $3)`,
          [batch, [ids.a.personAda], A.noImport],
        ),
      ),
    ).rejects.toThrow(/row-level security|import_commit_batch_key/);
    await expect(
      asImporter((c) =>
        c.query("UPDATE import_commit SET undone_at = now() WHERE batch_id = $1", [batch]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("hazard HZ-130 undoing an import in the database (app.undo_import_batch)", () => {
  async function committedBatch(people = 2) {
    const batch = await asImporter((c) => upload(c, people));
    await asImporter(dryRun(batch));
    const created = await asImporter((c) => commit(c, batch, people));
    return { batch, created };
  }
  const peopleLeft = (personIds: string[]) =>
    ownerDb(async (c) => {
      const { rows } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM person WHERE id = ANY ($1)",
        [personIds],
      );
      return rows[0]?.n;
    });

  it("is refused to anyone without both permissions across the organisation", async () => {
    const { batch, created } = await committedBatch(1);
    for (const [who, scope, locations] of [
      [A.northImporter, "tenant", []],
      [A.northImporter, "locations", [ids.a.locationNorth]],
      [A.noImport, "tenant", []],
      [A.importer, "locations", [ids.a.locationNorth]],
      [null, "tenant", []],
    ] as const) {
      await expect(
        inContext(app(), ctx(TENANT_A, who, scope, locations), undo(batch)),
        `${who} ${scope}`,
      ).rejects.toThrow(/missing_permission/);
    }
    expect(await peopleLeft(created)).toBe(1);
  });

  it("removes the people of a commit, whole, once, audited by count, leaving everyone else", async () => {
    const { batch, created } = await committedBatch(2);
    const { rows } = await asImporter(undo(batch));
    expect(rows).toEqual([{ removed: 2 }]);
    expect(await peopleLeft(created)).toBe(0);
    expect(await peopleLeft([ids.a.personAda, ids.a.personBen])).toBe(2);
    expect(
      await ownerDb(
        (c) => c.query("SELECT id FROM person WHERE id = $1", [ids.b.personDev]),
        TENANT_B,
      ).then((r) => r.rows.length),
    ).toBe(1);
    const state = await ownerDb(async (c) => ({
      batch: (await c.query("SELECT status FROM import_batch WHERE id = $1", [batch])).rows,
      commit: (
        await c.query(
          "SELECT undone_by, cardinality(record_ids) AS ids FROM import_commit WHERE batch_id = $1",
          [batch],
        )
      ).rows,
      audit: (
        await c.query(
          `SELECT actor_tenant_user_id, resource_id, scope FROM audit_event
            WHERE action = 'platform.import.undone' AND resource_id = $1`,
          [batch],
        )
      ).rows,
    }));
    expect(state).toEqual({
      batch: [{ status: "undone" }],
      commit: [{ undone_by: A.importer, ids: 2 }],
      audit: [{ actor_tenant_user_id: A.importer, resource_id: batch, scope: { records: 2 } }],
    });
    await expect(asImporter(undo(batch))).rejects.toThrow(/already_undone/);
  });

  it("is refused when a person has been changed or soft-deleted since, leaving the batch whole", async () => {
    const changed = await committedBatch(2);
    await asImporter((c) =>
      c.query("UPDATE person SET preferred_name = 'Id' WHERE id = $1", [changed.created[1]]),
    );
    await expect(asImporter(undo(changed.batch))).rejects.toThrow(/changed_since/);
    expect(await peopleLeft(changed.created)).toBe(2);

    const deleted = await committedBatch(1);
    await asImporter((c) =>
      c.query("UPDATE person SET deleted_at = now() WHERE id = $1", [deleted.created[0]]),
    );
    await expect(asImporter(undo(deleted.batch))).rejects.toThrow(/changed_since/);
  });

  it("is refused when a record has been made about a person since", async () => {
    const { batch, created } = await committedBatch(2);
    await asImporter((c) =>
      c.query("INSERT INTO allergy (person_id, substance, severity) VALUES ($1, 'Latex', 'mild')", [
        created[0],
      ]),
    );
    await expect(asImporter(undo(batch))).rejects.toThrow(/referenced_since/);
    expect(await peopleLeft(created)).toBe(2);
    const { rows } = await ownerDb((c) =>
      c.query("SELECT status FROM import_batch WHERE id = $1", [batch]),
    );
    expect(rows).toEqual([{ status: "committed" }]);
  });

  it("is refused for a batch never committed", async () => {
    const batch = await asImporter((c) => upload(c, 1));
    await expect(asImporter(undo(batch))).rejects.toThrow(/nothing_to_undo/);
  });

  it("is the only way the application removes a person", async () => {
    await expect(
      asImporter((c) => c.query("DELETE FROM person WHERE id = $1", [ids.a.personAda])),
    ).rejects.toThrow(/permission denied/);
  });
});
