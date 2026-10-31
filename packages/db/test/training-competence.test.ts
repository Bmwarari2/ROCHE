import { COMPETENCES, TRAINING_TOPICS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPETENCE_CODES, SUPERVISION_KINDS, TRAINING_TOPIC_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Training, observed competence, supervision and revalidation in the database (workforce.md
 * sections 2b and 3; ADR-0085; hazards HZ-119 and HZ-124; migration 0079): cross-tenant denial;
 * read organisation-wide by holders of the workforce read permissions and by the member for their
 * own rows; never written by the member about themselves; sign-offs observed in the observer's own
 * name by a holder of the observe permission, never for themselves, never in the future, never
 * changed; withdrawals append-only; and workforce reminder tasks visible to HR's role.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
/** HR (no person scope): training and supervision, not observation. */
const asHr = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** A North House team leader: observes competence and holds supervisions. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** The care worker, with workforce.self.read only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "none"), fn);

const SIGN_OFF = "0199f200-0000-7000-8000-0000000000a1";
const TRAINING = "0199f200-0000-7000-8000-0000000000b1";
const SUPERVISION = "0199f200-0000-7000-8000-0000000000c1";
const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);

const signOff = (
  c: pg.PoolClient,
  v: { id?: string; worker: string; observer?: string; observedOn?: string },
) =>
  c.query(
    `INSERT INTO competence_sign_off (id, worker_id, competence, observed_on, observer_id, valid_until)
     VALUES (COALESCE($1, app.uuid_v7()), $2, 'medicines_administration',
       COALESCE($3::date, DATE '2026-10-01'), COALESCE($4, app.current_user_id()),
       COALESCE($3::date, DATE '2026-10-01') + 364)`,
    [v.id ?? null, v.worker, v.observedOn ?? null, v.observer ?? null],
  );
const training = (c: pg.PoolClient, worker: string, id: string | null = null) =>
  c.query(
    `INSERT INTO training_record (id, worker_id, topic, completed_on)
     VALUES (COALESCE($1, app.uuid_v7()), $2, 'fire_safety', DATE '2026-09-01')`,
    [id, worker],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f200-0000-7000-8000-000000000501', 'hr', 'HR', 'none',
          '{workforce.training.manage,workforce.supervision.manage}'),
         ('0199f200-0000-7000-8000-000000000502', 'team_leader', 'Team leader', 'location',
          '{workforce.competence.observe,workforce.supervision.manage}'),
         ('0199f200-0000-7000-8000-000000000503', 'self', 'Self', 'assigned',
          '{workforce.self.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f200-0000-7000-8000-000000000501', NULL),
         ($2, '0199f200-0000-7000-8000-000000000502', $3),
         ($4, '0199f200-0000-7000-8000-000000000503', $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f200-0000-7000-8000-000000000504', 'hr', 'HR', 'none', '{workforce.training.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       VALUES ($1, '0199f200-0000-7000-8000-000000000504')`,
      [b.manager],
    );
  });
  await asNorth((c) => signOff(c, { id: SIGN_OFF, worker: a.carer }));
  await asHr((c) => training(c, a.carer, TRAINING));
  await asHr((c) => training(c, a.northManager));
  await asNorth((c) =>
    c.query(
      `INSERT INTO supervision_record (id, worker_id, kind, held_on) VALUES ($1, $2, 'supervision', DATE '2026-10-01')`,
      [SUPERVISION, a.carer],
    ),
  );
});

afterAll(async () => {
  await db?.drop();
});

describe("the development schema is in step with packages/domain", () => {
  it("lists the topics, competences and supervision kinds", () => {
    expect([...TRAINING_TOPIC_CODES]).toEqual([...TRAINING_TOPICS]);
    expect([...COMPETENCE_CODES]).toEqual([...COMPETENCES]);
    expect([...SUPERVISION_KINDS]).toEqual(["supervision", "appraisal", "spot_check"]);
  });
});

describe("hazard HZ-011 development records stay in their organisation", () => {
  it("never shows another organisation's rows", async () => {
    const seen = await asOtherTenant(async (c) => ({
      training: await count(c, "SELECT count(*) AS n FROM training_record"),
      signOffs: await count(c, "SELECT count(*) AS n FROM competence_sign_off"),
      supervisions: await count(c, "SELECT count(*) AS n FROM supervision_record"),
    }));
    expect(seen).toEqual({ training: 0, signOffs: 0, supervisions: 0 });
  });

  it("refuses a record for another organisation's member", async () => {
    await expect(asOtherTenant((c) => training(c, a.carer))).rejects.toThrow();
  });
});

describe("who reads and writes development records (workforce.md section 3)", () => {
  it("lets HR and a team leader read everyone's, organisation-wide", async () => {
    expect(await asHr((c) => count(c, "SELECT count(*) AS n FROM training_record"))).toBe(2);
    expect(await asNorth((c) => count(c, "SELECT count(*) AS n FROM training_record"))).toBe(2);
    expect(await asHr((c) => count(c, "SELECT count(*) AS n FROM competence_sign_off"))).toBe(1);
  });

  it("shows the member only their own, and lets them write nothing", async () => {
    const own = await asCarer(async (c) => ({
      training: (await c.query<{ id: string }>("SELECT id FROM training_record")).rows.map(
        (r) => r.id,
      ),
      supervisions: await count(c, "SELECT count(*) AS n FROM supervision_record"),
    }));
    expect(own).toEqual({ training: [TRAINING], supervisions: 1 });
    await expect(asCarer((c) => training(c, a.carer))).rejects.toThrow(/row-level security/);
  });

  it("never lets a holder write their own training", async () => {
    await expect(asHr((c) => training(c, a.manager))).rejects.toThrow(/row-level security/);
  });

  it("records a supervision in the name of whoever held it, and keeps it", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO supervision_record (worker_id, kind, held_on, held_by) VALUES ($1, 'appraisal', DATE '2026-10-01', $2)`,
          [a.carer, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asHr((c) =>
        c.query("UPDATE supervision_record SET held_by = $2 WHERE id = $1", [
          SUPERVISION,
          a.manager,
        ]),
      ),
    ).rejects.toThrow(/keeps who held it/);
  });

  it("keeps a training record's member", async () => {
    await expect(
      asHr((c) =>
        c.query("UPDATE training_record SET worker_id = $2 WHERE id = $1", [
          TRAINING,
          a.northManager,
        ]),
      ),
    ).rejects.toThrow(/keeps its member/);
  });
});

describe("hazard HZ-119 competence sign-offs (workforce.md section 2b)", () => {
  it("hazard HZ-119 is observed only by a holder of workforce.competence.observe", async () => {
    await expect(asHr((c) => signOff(c, { worker: a.carer }))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("hazard HZ-119 is observed only in the observer's own name", async () => {
    await expect(
      asNorth((c) => signOff(c, { worker: a.carer, observer: a.manager })),
    ).rejects.toThrow(/row-level security/);
  });

  it("hazard HZ-119 is never signed off for oneself", async () => {
    await expect(asNorth((c) => signOff(c, { worker: a.northManager }))).rejects.toThrow();
  });

  it("hazard HZ-119 is never dated in the future", async () => {
    await expect(
      asNorth((c) => signOff(c, { worker: a.carer, observedOn: "2099-01-01" })),
    ).rejects.toThrow(/row-level security/);
  });

  it("hazard HZ-119 is never changed or deleted, by anyone", async () => {
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query("UPDATE competence_sign_off SET valid_until = DATE '2099-01-01' WHERE id = $1", [
          SIGN_OFF,
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query("DELETE FROM competence_sign_off WHERE id = $1", [SIGN_OFF]),
      ),
    ).rejects.toThrow();
  });

  it("hazard HZ-119 is withdrawn with a reason, never by the member, and the withdrawal stays", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          "INSERT INTO competence_withdrawal (sign_off_id, reason) VALUES ($1, 'I want to withdraw it')",
          [SIGN_OFF],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asHr((c) =>
        c.query("INSERT INTO competence_withdrawal (sign_off_id, reason) VALUES ($1, 'short')", [
          SIGN_OFF,
        ]),
      ),
    ).rejects.toThrow(/competence_withdrawal_reason/);
    await asHr((c) =>
      c.query(
        "INSERT INTO competence_withdrawal (sign_off_id, reason) VALUES ($1, 'Observed error at the medicines round')",
        [SIGN_OFF],
      ),
    );
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query("DELETE FROM competence_withdrawal WHERE sign_off_id = $1", [SIGN_OFF]),
      ),
    ).rejects.toThrow();
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM competence_withdrawal"))).toBe(
      1,
    );
  });
});

describe("workforce reminder tasks reach their permission's holders (workforce.md section 5)", () => {
  it("shows HR's role the tasks of a permission it holds, and nobody else's", async () => {
    await asSystem((c) =>
      c.query(
        `INSERT INTO task (kind, title, required_permission, due_at, assignee_role_key) VALUES
           ('workforce.training_expiry', 'Renew training before it expires', 'workforce.training.manage', now(), 'hr'),
           ('workforce.compliance_expiry', 'Renew a staff check before it expires', 'workforce.staff_file.manage', now(), 'hr')`,
      ),
    );
    const titles = (fn: typeof asHr) =>
      fn(async (c) =>
        (
          await c.query<{ kind: string }>(
            "SELECT kind FROM task WHERE kind LIKE 'workforce.%' ORDER BY kind",
          )
        ).rows.map((r) => r.kind),
      );
    expect(await titles(asHr)).toEqual(["workforce.training_expiry"]);
    expect(await titles(asCarer)).toEqual([]);
  });
});
