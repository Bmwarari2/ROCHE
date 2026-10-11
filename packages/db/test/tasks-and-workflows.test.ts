import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Tasks and workflows follow the same isolation as the records they are about (ADR-0002): a task
 * about a person is visible only to those who can see the person; other tasks to tenant-wide roles,
 * the assignee and staff at the location. Workflow history is append-only.
 */

let db: TestDatabase;
const a = ids.a;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO task (kind, title, required_permission, person_id, location_id, due_at) VALUES
         ('care.reposition', 'Ada task', 'care.note.write', $1, $3, now()),
         ('care.reposition', 'Ben task', 'care.note.write', $2, $3, now()),
         ('operations.fire_check', 'North fire check', 'platform.task.manage', NULL, $3, now()),
         ('operations.fire_check', 'South fire check', 'platform.task.manage', NULL, $4, now())`,
      [a.personAda, a.personBen, a.locationNorth, a.locationSouth],
    );
    await c.query(
      `INSERT INTO task (kind, title, required_permission, assignee_tenant_user_id, due_at)
       VALUES ('platform.training', 'Carer own task', 'platform.task.manage', $1, now())`,
      [a.carer],
    );
    await c.query(
      `INSERT INTO workflow_instance (definition_key, definition_version, subject_type, subject_id, person_id, state)
       VALUES ('safety.incident', 1, 'incident', app.uuid_v7(), $1, 'open'),
              ('safety.incident', 1, 'incident', app.uuid_v7(), $2, 'open')`,
      [a.personAda, a.personBen],
    );
  });
  await inContext(db.pool("harbour_owner"), ctx(TENANT_B, null, "tenant"), (c) =>
    c.query(
      `INSERT INTO task (kind, title, required_permission, person_id, location_id, due_at)
       VALUES ('care.reposition', 'Dev task', 'care.note.write', $1, $2, now())`,
      [ids.b.personDev, ids.b.location],
    ),
  );
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");

async function visibleTasks(context: ReturnType<typeof ctx>): Promise<string[]> {
  return inContext(app(), context, async (c) => {
    const { rows } = await c.query<{ title: string }>("SELECT title FROM task ORDER BY title");
    return rows.map((r) => r.title);
  });
}

describe("hazard HZ-011 task scope", () => {
  it("shows a care worker tasks for their assigned people and their own tasks only", async () => {
    expect(await visibleTasks(ctx(TENANT_A, a.carer, "assigned"))).toEqual([
      "Ada task",
      "Carer own task",
    ]);
  });

  it("shows a location manager the people and location tasks at their location", async () => {
    expect(
      await visibleTasks(ctx(TENANT_A, a.northManager, "locations", [a.locationNorth])),
    ).toEqual(["Ada task", "Ben task", "North fire check"]);
  });

  it("shows a tenant-wide role every task in the tenant and none from another tenant", async () => {
    expect(await visibleTasks(ctx(TENANT_A, a.manager, "tenant"))).toEqual([
      "Ada task",
      "Ben task",
      "Carer own task",
      "North fire check",
      "South fire check",
    ]);
    expect(await visibleTasks(ctx(TENANT_B, ids.b.manager, "tenant"))).toEqual(["Dev task"]);
  });

  it("stops a care worker creating a task about someone outside their scope", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.carer, "assigned"), (c) =>
        c.query(
          `INSERT INTO task (kind, title, required_permission, person_id, due_at)
           VALUES ('care.reposition', 'Sneaky', 'care.note.write', $1, now())`,
          [a.personCara],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a task that points at another tenant's person", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO task (kind, title, required_permission, person_id, due_at)
           VALUES ('care.reposition', 'Cross', 'care.note.write', $1, now())`,
          [ids.b.personDev],
        ),
      ),
    ).rejects.toThrow();
  });

  it("does not create a second task for the same series and due time", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO task_series (kind, title, required_permission, person_id, recurrence, starts_on)
           VALUES ('care.reposition', 'Turn', 'care.note.write', $1, '{"freq":"every_hours","hours":4,"anchorTime":"02:00"}', current_date)
           RETURNING id`,
          [a.personAda],
        );
        const series = rows[0]?.id;
        for (let i = 0; i < 2; i++) {
          await c.query(
            `INSERT INTO task (series_id, kind, title, required_permission, person_id, due_at)
             VALUES ($1, 'care.reposition', 'Turn', 'care.note.write', $2, '2026-11-02T02:00:00Z')`,
            [series, a.personAda],
          );
        }
      }),
    ).rejects.toThrow(/task_series_due_key/);
  });

  it("keeps a version history of task changes", async () => {
    const versions = await inContext(app(), ctx(TENANT_A, a.manager, "tenant"), async (c) => {
      await c.query(
        "UPDATE task SET status = 'done', completed_at = now(), completed_by = $1 WHERE title = 'North fire check'",
        [a.manager],
      );
      const { rows } = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM record_version WHERE table_name = 'task'",
      );
      return Number(rows[0]?.n);
    });
    expect(versions).toBe(1);
  });
});

describe("hazard HZ-011 workflow scope and history", () => {
  it("shows workflow instances only for people in scope", async () => {
    const count = await inContext(app(), ctx(TENANT_A, a.carer, "assigned"), async (c) => {
      const { rows } = await c.query<{ n: string }>("SELECT count(*) AS n FROM workflow_instance");
      return Number(rows[0]?.n);
    });
    expect(count).toBe(1);
  });

  it("keeps transitions append-only", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO workflow_transition (instance_id, person_id, from_state, to_state)
           SELECT id, person_id, 'open', 'under_review' FROM workflow_instance LIMIT 1
           RETURNING id`,
        );
        await c.query("UPDATE workflow_transition SET to_state = 'closed' WHERE id = $1", [
          rows[0]?.id,
        ]);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
