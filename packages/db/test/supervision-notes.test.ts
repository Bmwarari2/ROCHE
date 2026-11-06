import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Supervision notes in the database (workforce.md sections 2b, 3 and 8; H-692's default, ADR-0114;
 * migration 0114). What was discussed is likely special category content, so it is read by its
 * writer, the member it is about and a supervisor for the member (organisation-wide HR, or a holder
 * where the member works), never by a training lead, a staff file reader, a competence observer, a
 * supervisor at another location or a tenant-wide role; it is written by whoever held the
 * supervision, in their own name, about its own member, never about themselves; and it is never
 * changed: a correction is a new note superseding the one before.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
/** A supervisor: workforce.supervision.manage. */
const asSupervisor = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "none"), fn);
/** A training lead and staff file reader, without the supervision permission. */
const asTrainingLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** The care worker the supervision is about, with workforce.self.read. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
/** A supervisor at South House only: the carer works at North House. */
const SOUTH = "0199f300-0000-7000-8000-000000000311";
const asSouthSupervisor = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, SOUTH, "locations", [a.locationSouth]), fn);
/** A group executive: supervision.manage through a tenant-wide role. */
const EXECUTIVE = "0199f300-0000-7000-8000-000000000312";
const asExecutive = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, EXECUTIVE, "tenant"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "none"), fn);

const SUPERVISION = "0199f300-0000-7000-8000-0000000000c1";
/** A supervision of the supervisor themselves, held by the training lead. */
const OWN_SUPERVISION = "0199f300-0000-7000-8000-0000000000c2";
const DISCUSSION = "Talked through the night shifts and a refresher on moving and handling.";
const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);
const note = (
  c: pg.PoolClient,
  supervision: string,
  worker: string,
  writtenBy?: string,
  supersedes?: string,
) =>
  c.query<{ id: string }>(
    `INSERT INTO supervision_note (supervision_id, worker_id, discussion, actions, written_by, supersedes_id)
     VALUES ($1, $2, $3, 'Book the refresher', COALESCE($4, app.current_user_id()), $5)
     RETURNING id`,
    [supervision, worker, DISCUSSION, writtenBy ?? null, supersedes ?? null],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status) VALUES
         ($1, 'Sam Example', 'south.s57@example.invalid', 'active'),
         ($2, 'Gail Example', 'executive.s57@example.invalid', 'active')`,
      [SOUTH, EXECUTIVE],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f300-0000-7000-8000-000000000504', 'south_supervisor', 'Supervisor', 'location',
          '{workforce.supervision.manage}'),
         ('0199f300-0000-7000-8000-000000000505', 'executive', 'Executive', 'tenant',
          '{workforce.supervision.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f300-0000-7000-8000-000000000504', $2),
         ($3, '0199f300-0000-7000-8000-000000000505', NULL)`,
      [SOUTH, a.locationSouth, EXECUTIVE],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f300-0000-7000-8000-000000000501', 'supervisor', 'Supervisor', 'none',
          '{workforce.supervision.manage}'),
         ('0199f300-0000-7000-8000-000000000502', 'training_lead', 'Training lead', 'none',
          '{workforce.training.manage,workforce.staff_file.read,workforce.competence.observe}'),
         ('0199f300-0000-7000-8000-000000000503', 'self', 'Self', 'assigned',
          '{workforce.self.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f300-0000-7000-8000-000000000501', NULL),
         ($2, '0199f300-0000-7000-8000-000000000502', NULL),
         ($3, '0199f300-0000-7000-8000-000000000503', $4)`,
      [a.northManager, a.manager, a.carer, a.locationNorth],
    );
  });
  await asSystem(async (c) => {
    await c.query(
      `INSERT INTO supervision_record (id, worker_id, kind, held_on, held_by)
       VALUES ($1, $2, 'supervision', DATE '2026-10-01', $3),
              ($4, $3, 'supervision', DATE '2026-10-01', $5)`,
      [SUPERVISION, a.carer, a.northManager, OWN_SUPERVISION, a.manager],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("writing a supervision note", () => {
  it("is refused to a training lead without the supervision permission", async () => {
    await expect(asTrainingLead((c) => note(c, SUPERVISION, a.carer))).rejects.toThrow(
      /row-level security|by whoever held it/,
    );
  });

  it("is refused to the member it is about", async () => {
    await expect(asCarer((c) => note(c, SUPERVISION, a.carer))).rejects.toThrow(
      /row-level security|by whoever held it/,
    );
  });

  it("is never in someone else's name", async () => {
    await expect(asSupervisor((c) => note(c, SUPERVISION, a.carer, a.manager))).rejects.toThrow(
      /row-level security|by whoever held it/,
    );
  });

  it("is never about anyone but the supervision's member", async () => {
    await expect(asSupervisor((c) => note(c, SUPERVISION, a.manager))).rejects.toThrow(
      /supervision's member of staff/,
    );
  });

  it("is never about the supervisor themselves", async () => {
    await expect(asSupervisor((c) => note(c, OWN_SUPERVISION, a.northManager))).rejects.toThrow(
      /row-level security|supervision_note_not_self|by whoever held it/,
    );
  });

  it("is never written on a supervision someone else held", async () => {
    await expect(asSouthSupervisor((c) => note(c, SUPERVISION, a.carer))).rejects.toThrow(
      /by whoever held it/,
    );
  });

  it("is written by whoever held it, corrected by a new note, and never changed or removed", async () => {
    const [first] = (await asSupervisor((c) => note(c, SUPERVISION, a.carer))).rows;
    // One original per supervision.
    await expect(asSupervisor((c) => note(c, SUPERVISION, a.carer))).rejects.toThrow(
      /supervision_note_original_key/,
    );
    // A correction supersedes it, once.
    await asSupervisor((c) => note(c, SUPERVISION, a.carer, undefined, first?.id));
    await expect(
      asSupervisor((c) => note(c, SUPERVISION, a.carer, undefined, first?.id)),
    ).rejects.toThrow(/supervision_note_supersedes_key/);
    // Never a note of another supervision.
    await expect(
      asSupervisor((c) => note(c, OWN_SUPERVISION, a.manager, a.manager, first?.id)),
    ).rejects.toThrow(/row-level security|same supervision|by whoever held it/);
    await expect(
      asSupervisor((c) => c.query("UPDATE supervision_note SET discussion = 'Changed text here'")),
    ).rejects.toThrow(/permission denied|append-only|not allowed/i);
    await expect(asSupervisor((c) => c.query("DELETE FROM supervision_note"))).rejects.toThrow(
      /permission denied|append-only|not allowed/i,
    );
  });
});

describe("reading supervision notes", () => {
  const notes = (fn: typeof asSupervisor) =>
    fn((c) => count(c, "SELECT count(*) AS n FROM supervision_note"));

  it("shows the notes to their writer and to the member it is about", async () => {
    expect(await notes(asSupervisor)).toBe(2);
    expect(await notes(asCarer)).toBe(2);
  });

  it("hides them from a supervisor at another location and from a tenant-wide role", async () => {
    expect(await notes(asSouthSupervisor)).toBe(0);
    expect(await notes(asExecutive)).toBe(0);
  });

  it("hides them from a training lead, staff file reader and observer, who still sees the supervision", async () => {
    expect(await notes(asTrainingLead)).toBe(0);
    expect(
      await asTrainingLead((c) =>
        count(c, "SELECT count(*) AS n FROM supervision_record WHERE id = $1", [SUPERVISION]),
      ),
    ).toBe(1);
  });

  it("hides it from another organisation", async () => {
    expect(await notes(asOtherTenant)).toBe(0);
  });

  it("hides every note from every reader, the system included, once its supervision is soft-deleted", async () => {
    expect(await notes(asSystem)).toBe(2);
    // Recorded in error: the supervision record is soft-deleted.
    await asSystem((c) =>
      c.query("UPDATE supervision_record SET deleted_at = now() WHERE id = $1", [SUPERVISION]),
    );
    for (const reader of [asSystem, asSupervisor, asCarer, asTrainingLead, asExecutive]) {
      expect(await notes(reader)).toBe(0);
    }
    // The rows stay (append-only), hidden: the owner role still finds them.
    expect(
      await asOwner(TENANT_A, (c) => count(c, "SELECT count(*) AS n FROM supervision_note")),
    ).toBe(2);
  });
});
