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
  /** Holds platform.import.run but may not create people (#150 security review L1). */
  runOnly: "0193a000-0000-7000-8000-000000000304",
  roleRunOnly: "0193a000-0000-7000-8000-000000000604",
  /** May import and create people but not read them: a dry run names records (round 2). */
  createNoRead: "0193a000-0000-7000-8000-000000000305",
  roleCreateNoRead: "0193a000-0000-7000-8000-000000000605",
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
      `INSERT INTO person (location_id, status, nhs_number, given_name, family_name, date_of_birth,
                           import_batch_id)
       VALUES ($1, 'active', $2, 'Ida', 'Example', '1940-02-01', $3) RETURNING id`,
      [ids.a.locationNorth, nextNhs(), batch],
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
  // The undo window as rates.md holds it (the function reads the rate table, as the API does).
  await inContext(db.pool("harbour_owner"), null, (c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('import.undo_window_days', 7, 'days', 'all', '2000-01-01', 'rates.md', 'to-verify')`,
    ),
  );
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-a-run-only', 'Ray Runner', 'ray.runner@example.invalid', 'active'),
         ($2, 'auth-a-blind', 'Bea Blind', 'bea.blind@example.invalid', 'active')`,
      [A.runOnly, A.createNoRead],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'importer', 'Importer', 'tenant', $4),
         ($2, 'north_importer', 'North importer', 'location', $4),
         ($3, 'reader', 'Reader', 'tenant', '{people.person.read,people.person.create}'),
         ($5, 'run_only', 'Run only', 'tenant', '{platform.import.run,people.person.read}'),
         ($6, 'create_no_read', 'Create, no read', 'tenant',
          '{platform.import.run,people.person.create}')`,
      [
        A.roleImporter,
        A.roleNorthImporter,
        A.roleReader,
        IMPORT,
        A.roleRunOnly,
        A.roleCreateNoRead,
      ],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, $5), ($6, $7, NULL), ($8, $9, NULL), ($10, $11, NULL)`,
      [
        A.importer,
        A.roleImporter,
        A.northImporter,
        A.roleNorthImporter,
        ids.a.locationNorth,
        A.noImport,
        A.roleReader,
        A.runOnly,
        A.roleRunOnly,
        A.createNoRead,
        A.roleCreateNoRead,
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
      // The import permission without the right to create people reaches no batch (#150 L1).
      [A.runOnly, "tenant", []],
      // Nor without the right to read people: a dry run names the records a row matches.
      [A.createNoRead, "tenant", []],
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
      audit: [
        {
          actor_tenant_user_id: A.importer,
          resource_id: batch,
          scope: { records: 2, recordType: "people" },
        },
      ],
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

  it("hazard HZ-130 removes only people its own batch created, whatever the commit record lists", async () => {
    const batch = await asImporter((c) => upload(c, 1));
    await asImporter(dryRun(batch));
    const created = await asImporter(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO person (location_id, status, nhs_number, given_name, family_name,
                             date_of_birth, import_batch_id)
         VALUES ($1, 'active', $2, 'Ida', 'Example', '1940-02-01', $3) RETURNING id`,
        [ids.a.locationNorth, nextNhs(), batch],
      );
      await c.query(
        "UPDATE import_batch SET status = 'committed', closed_at = now(), closed_by = $2 WHERE id = $1",
        [batch, A.importer],
      );
      // A commit record that also lists someone the batch never created.
      await c.query(
        "INSERT INTO import_commit (batch_id, record_ids, record_count) VALUES ($1, $2, 2)",
        [batch, [rows[0]?.id, ids.a.personAda]],
      );
      return rows[0]?.id ?? "";
    });
    await expect(asImporter(undo(batch))).rejects.toThrow(/changed_since/);
    expect(await peopleLeft([created, ids.a.personAda])).toBe(2);
  });

  it("hazard HZ-130 refuses an undo past the window, read from the rate table in the database", async () => {
    const { batch, created } = await committedBatch(1);
    // The organisation's own window of no days at all: the commit is already outside it.
    await ownerDb((c) =>
      c.query(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source,
                                 verification_status)
         VALUES ($1, 'import.undo_window_days', 0, 'days', 'all', '2000-01-01', 'test', 'tenant')`,
        [TENANT_A],
      ),
    );
    try {
      await expect(asImporter(undo(batch))).rejects.toThrow(/window_passed/);
      expect(await peopleLeft(created)).toBe(1);
    } finally {
      await ownerDb((c) =>
        c.query(
          "UPDATE rate_table SET valid_to = '2000-01-02' WHERE tenant_id = $1 AND key = 'import.undo_window_days'",
          [TENANT_A],
        ),
      );
    }
  });

  it("hazard HZ-130 ties a person to an import batch only as the batch commits, and never changes it", async () => {
    const staged = await asImporter((c) => upload(c, 1));
    const insert = (batch: string) => (c: pg.PoolClient) =>
      c.query(
        `INSERT INTO person (location_id, status, nhs_number, given_name, family_name,
                             date_of_birth, import_batch_id)
         VALUES ($1, 'active', $2, 'Ida', 'Example', '1940-02-01', $3)`,
        [ids.a.locationNorth, nextNhs(), batch],
      );
    // Not dry-run yet, then closed: no person may claim the batch.
    await expect(asImporter(insert(staged))).rejects.toThrow(/import_batch_not_committing/);
    const { batch: done } = await committedBatch(1);
    await expect(asImporter(insert(done))).rejects.toThrow(/import_batch_not_committing/);
    await expect(
      asImporter((c) =>
        c.query("UPDATE person SET import_batch_id = $2 WHERE id = $1", [ids.a.personAda, done]),
      ),
    ).rejects.toThrow(/import_batch_fixed/);
    // Nor may someone who cannot reach imports name a batch.
    await asImporter(dryRun(staged));
    await expect(
      inContext(app(), ctx(TENANT_A, A.noImport, "tenant"), insert(staged)),
    ).rejects.toThrow(/import_batch_not_committing/);
  });

  it("hazard HZ-007 takes the commit's open allergy status checks with the people, and stops at one acted on", async () => {
    const raise = (batch: string, personId: string, status: string) => (c: pg.PoolClient) =>
      c.query(
        `INSERT INTO task (kind, title, required_permission, person_id, location_id, source_type,
                           source_id, assignee_role_key, due_at, priority, status, details)
         VALUES ('people.allergy_status_check', 'Check the allergy status', 'people.person.update',
                 $2, $3, 'import_batch', $1, 'registered_manager', now(), 'urgent', $4,
                 '{"importedAllergyStatus": "has_allergies"}')`,
        [batch, personId, ids.a.locationNorth, status],
      );
    const open = await committedBatch(1);
    await ownerDb(raise(open.batch, open.created[0] ?? "", "open"));
    const { rows } = await asImporter(undo(open.batch));
    expect(rows).toEqual([{ removed: 1 }]);
    const left = await ownerDb(
      async (c) =>
        (await c.query("SELECT id FROM task WHERE source_id = $1", [open.batch])).rows.length,
    );
    expect(left).toBe(0);
    const started = await committedBatch(1);
    await ownerDb(raise(started.batch, started.created[0] ?? "", "in_progress"));
    await expect(asImporter(undo(started.batch))).rejects.toThrow(/referenced_since/);
    expect(await peopleLeft(started.created)).toBe(1);
  });

  it("hazard HZ-130 never commits a batch past its expiry", async () => {
    const batch = await asImporter((c) => upload(c, 1, "-1 minute"));
    await asImporter(dryRun(batch));
    await expect(
      asImporter((c) =>
        c.query(
          "UPDATE import_batch SET status = 'committed', closed_at = now(), closed_by = $2 WHERE id = $1",
          [batch, A.importer],
        ),
      ),
    ).rejects.toThrow(/import_expired/);
  });

  // Last: the sync token it records stays in the organisation's audit trail.
  it("hazard HZ-130 refuses an undo once a phone may hold the people (a people sync token since the commit)", async () => {
    const { batch, created } = await committedBatch(1);
    // A token for a phone that syncs no people at any home does not count.
    await asImporter((c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, scope)
         VALUES ($1, 'sync.token.issue', '{"peopleLocations": 0, "peopleAssigned": true}')`,
        [TENANT_A],
      ),
    );
    const second = await committedBatch(1);
    await asImporter((c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, scope)
         VALUES ($1, 'sync.token.issue', '{"peopleLocations": 1, "peopleAssigned": false}')`,
        [TENANT_A],
      ),
    );
    await expect(asImporter(undo(batch))).rejects.toThrow(/sent_to_devices/);
    await expect(asImporter(undo(second.batch))).rejects.toThrow(/sent_to_devices/);
    expect(await peopleLeft([...created, ...second.created])).toBe(2);
  });
});
