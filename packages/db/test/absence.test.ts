import { ABSENCE_KINDS, ABSENCE_STATES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ABSENCE_KIND_CODES, ABSENCE_STATE_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Absence and leave in the database (scheduling.md section 15; SCHED-010; migration 0107; hazards
 * HZ-123 and HZ-124): a member reads and asks for their own; rota managers and approvers read those
 * at their home; a decision only by an approver there, never the member; fit notes and return to
 * work only for holders of workforce.hr_document.read (health data), append-only; cover needs
 * raised only for the absent member's own assignments and resolved once. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** North's manager: rota manager, approver and HR at North. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** A planner at North: builds the rota, approves nothing, no HR documents. */
const asPlanner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "locations", [a.locationNorth]), fn);
/** The care worker, with scheduling.timesheet.self only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const ROTA = "0199f310-0000-7000-8000-0000000000a1";
const SHIFT = "0199f310-0000-7000-8000-0000000000c1";
const ASSIGNMENT = "0199f310-0000-7000-8000-0000000000d1";
const DOC = "0199f310-0000-7000-8000-0000000000e1";
const HASH = "a".repeat(64);
const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);

const ASK = `INSERT INTO absence (member_id, location_id, kind, starts_on, ends_on, state)
  VALUES ($1, $2, 'annual_leave', '2026-11-02', '2026-11-06', 'requested') RETURNING id`;
const RECORD = `INSERT INTO absence (member_id, location_id, kind, starts_on, ends_on, state)
  VALUES ($1, $2, 'sickness', '2026-11-02', NULL, 'recorded') RETURNING id`;
const decide = (
  c: pg.PoolClient,
  id: string,
  state: string,
  by: string,
  reason: string | null = null,
) =>
  c.query(
    "UPDATE absence SET state = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1",
    [id, state, by, reason],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f310-0000-7000-8000-000000000501', 'lead', 'Lead', 'location',
          '{scheduling.rota.manage,scheduling.rota.approve,workforce.hr_document.read}'),
         ('0199f310-0000-7000-8000-000000000502', 'planner', 'Planner', 'location',
          '{scheduling.rota.manage}'),
         ('0199f310-0000-7000-8000-000000000503', 'self', 'Self', 'assigned',
          '{scheduling.timesheet.self}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f310-0000-7000-8000-000000000501', $4),
         ($2, '0199f310-0000-7000-8000-000000000502', $4),
         ($3, '0199f310-0000-7000-8000-000000000503', $4),
         ($1, '0199f310-0000-7000-8000-000000000503', $4)`,
      [a.northManager, a.manager, a.carer, a.locationNorth],
    );
    await c.query(
      `INSERT INTO rota (id, location_id, starts_on, ends_on) VALUES ($1, $2, '2026-11-02', '2026-11-08')`,
      [ROTA, a.locationNorth],
    );
    await c.query(
      `INSERT INTO shift (id, rota_id, location_id, label, kind, starts_at, ends_at, break_minutes)
       VALUES ($1, $2, $3, 'Day', 'work', '2026-11-03T08:00:00Z', '2026-11-03T16:00:00Z', 30)`,
      [SHIFT, ROTA, a.locationNorth],
    );
    await c.query(
      "INSERT INTO shift_assignment (id, shift_id, location_id, worker_id) VALUES ($1, $2, $3, $4)",
      [ASSIGNMENT, SHIFT, a.locationNorth, a.carer],
    );
    await c.query(
      `INSERT INTO document (id, category, title, retention_class, storage_key, content_type, size_bytes, sha256)
       VALUES ($1, 'staff_hr_document', 'Fit note', 'sickness_absence', 'fit-note-1', 'application/pdf', 10, $2)`,
      [DOC, HASH],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("the codes match the domain", () => {
  it("lists the same kinds and states", () => {
    expect([...ABSENCE_KIND_CODES]).toEqual([...ABSENCE_KINDS]);
    expect([...ABSENCE_STATE_CODES]).toEqual([...ABSENCE_STATES]);
  });
});

describe("migration 0107 an absence is its member's and their home's managers'", () => {
  it("is asked for by the member themselves, read by them and by North's managers, by nobody else", async () => {
    const asked = await asCarer((c) => c.query<{ id: string }>(ASK, [a.carer, a.locationNorth]));
    expect(asked.rows).toHaveLength(1);
    // Not for someone else, and a sickness is recorded by a manager, never asked for.
    await expect(asCarer((c) => c.query(ASK, [a.manager, a.locationNorth]))).rejects.toThrow(
      /row-level security/,
    );
    await expect(asCarer((c) => c.query(RECORD, [a.carer, a.locationNorth]))).rejects.toThrow(
      /row-level security/,
    );
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM absence"))).toBe(1);
    expect(await asPlanner((c) => count(c, "SELECT count(*) AS n FROM absence"))).toBe(1);
    expect(await asNorth((c) => count(c, "SELECT count(*) AS n FROM absence"))).toBe(1);
    expect(await asSystem((c) => count(c, "SELECT count(*) AS n FROM absence"))).toBe(1);
    expect(await asOtherTenant((c) => count(c, "SELECT count(*) AS n FROM absence"))).toBe(0);
    await expect(asSystem((c) => c.query(ASK, [a.carer, a.locationNorth]))).rejects.toThrow(
      /row-level security/,
    );
    await expect(asNorth((c) => c.query("DELETE FROM absence"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("is decided only by an approver there, never the member, and nothing moves back", async () => {
    const asked = await asNorth((c) =>
      c.query<{ id: string }>(ASK, [a.northManager, a.locationNorth]),
    );
    const own = asked.rows[0]?.id as string;
    // North's manager may approve leave, but never their own.
    await expect(asNorth((c) => decide(c, own, "approved", a.northManager))).rejects.toThrow(
      /absence_decider_is_member|absence_decider/,
    );
    const carers = await asCarer((c) => c.query<{ id: string }>(ASK, [a.carer, a.locationNorth]));
    const id = carers.rows[0]?.id as string;
    // A planner without approve may not decide; nobody decides in another's name.
    await expect(asPlanner((c) => decide(c, id, "approved", a.manager))).rejects.toThrow(
      /absence_decider_is_member/,
    );
    await expect(asNorth((c) => decide(c, id, "approved", a.manager))).rejects.toThrow(
      /absence_decider_not_you/,
    );
    await expect(asNorth((c) => decide(c, id, "declined", a.northManager))).rejects.toThrow(
      /absence_reason/,
    );
    await asNorth((c) => decide(c, id, "approved", a.northManager));
    await expect(asNorth((c) => decide(c, id, "requested", a.northManager))).rejects.toThrow(
      /absence_wrong_state|absence_decision/,
    );
    // The member cannot cancel an approved absence; a manager can, and then it is closed.
    await expect(
      asCarer((c) => c.query("UPDATE absence SET state = 'cancelled' WHERE id = $1", [id])),
    ).rejects.toThrow(/absence_member_cancels_request_only/);
    await asNorth((c) =>
      c.query(
        "UPDATE absence SET state = 'cancelled', decision_reason = 'Rota changed' WHERE id = $1",
        [id],
      ),
    );
    await expect(
      asNorth((c) => c.query("UPDATE absence SET ends_on = '2026-11-07' WHERE id = $1", [id])),
    ).rejects.toThrow(/absence_closed/);
    await expect(
      asNorth((c) => c.query("UPDATE absence SET kind = 'unpaid' WHERE id = $1", [own])),
    ).rejects.toThrow(/absence_fixed/);
  });
});

describe("migration 0107 fit notes and return to work are health data", () => {
  it("are added and read only by holders of workforce.hr_document.read, and by the member", async () => {
    const recorded = await asPlanner((c) =>
      c.query<{ id: string }>(RECORD, [a.carer, a.locationNorth]),
    );
    const sickness = recorded.rows[0]?.id as string;
    const NOTE = `INSERT INTO fit_note (absence_id, location_id, document_id, issued_on, covers_from, covers_to, fitness)
      VALUES ($1, $2, $3, '2026-11-09', '2026-11-09', '2026-11-20', 'not_fit')`;
    await expect(asPlanner((c) => c.query(NOTE, [sickness, a.locationNorth, DOC]))).rejects.toThrow(
      /row-level security/,
    );
    await asNorth((c) => c.query(NOTE, [sickness, a.locationNorth, DOC]));
    expect(await asPlanner((c) => count(c, "SELECT count(*) AS n FROM fit_note"))).toBe(0);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM fit_note"))).toBe(1);
    expect(await asNorth((c) => count(c, "SELECT count(*) AS n FROM fit_note"))).toBe(1);
    expect(await asOtherTenant((c) => count(c, "SELECT count(*) AS n FROM fit_note"))).toBe(0);
    await expect(
      asNorth((c) => c.query("UPDATE fit_note SET fitness = 'may_be_fit'")),
    ).rejects.toThrow(/permission denied/);
    // Return to work once the sickness has ended, held by the one recording it, never the member.
    const RTW = `INSERT INTO return_to_work (absence_id, location_id, member_id, held_on, held_by, fit_for_usual_duties, notes)
      VALUES ($1, $2, $3, '2026-11-21', $4, true, 'Back to usual duties.')`;
    await expect(
      asNorth((c) => c.query(RTW, [sickness, a.locationNorth, a.carer, a.northManager])),
    ).rejects.toThrow(/row-level security/);
    await asPlanner((c) =>
      c.query("UPDATE absence SET ends_on = '2026-11-20' WHERE id = $1", [sickness]),
    );
    await expect(
      asPlanner((c) => c.query(RTW, [sickness, a.locationNorth, a.carer, a.manager])),
    ).rejects.toThrow(/row-level security/);
    await asNorth((c) => c.query(RTW, [sickness, a.locationNorth, a.carer, a.northManager]));
    expect(await asPlanner((c) => count(c, "SELECT count(*) AS n FROM return_to_work"))).toBe(0);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM return_to_work"))).toBe(1);
    await expect(
      asNorth((c) => c.query(RTW, [sickness, a.locationNorth, a.carer, a.northManager])),
    ).rejects.toThrow(/return_to_work_absence_key|duplicate/);
  });
});

describe("hazard HZ-123 migration 0107 cover needs", () => {
  it("are raised only for the absent member's own assignment, read with the rota, resolved once", async () => {
    const recorded = await asPlanner((c) =>
      c.query<{ id: string }>(RECORD, [a.carer, a.locationNorth]),
    );
    const sickness = recorded.rows[0]?.id as string;
    const RAISE = `INSERT INTO shift_cover_need (shift_id, assignment_id, absence_id, location_id)
      VALUES ($1, $2, $3, $4) RETURNING id`;
    // An absence of another member does not raise a need on the carer's assignment.
    const other = await asPlanner((c) =>
      c.query<{ id: string }>(RECORD, [a.northManager, a.locationNorth]),
    );
    await expect(
      asPlanner((c) => c.query(RAISE, [SHIFT, ASSIGNMENT, other.rows[0]?.id, a.locationNorth])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asCarer((c) => c.query(RAISE, [SHIFT, ASSIGNMENT, sickness, a.locationNorth])),
    ).rejects.toThrow(/row-level security/);
    const raised = await asPlanner((c) =>
      c.query<{ id: string }>(RAISE, [SHIFT, ASSIGNMENT, sickness, a.locationNorth]),
    );
    const need = raised.rows[0]?.id as string;
    expect(await asPlanner((c) => count(c, "SELECT count(*) AS n FROM shift_cover_need"))).toBe(1);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM shift_cover_need"))).toBe(0);
    expect(await asOtherTenant((c) => count(c, "SELECT count(*) AS n FROM shift_cover_need"))).toBe(
      0,
    );
    await asPlanner((c) =>
      c.query(
        "UPDATE shift_cover_need SET resolved_at = now(), resolution = 'absence_ended' WHERE id = $1",
        [need],
      ),
    );
    await expect(
      asPlanner((c) =>
        c.query("UPDATE shift_cover_need SET resolution = 'assignment_removed' WHERE id = $1", [
          need,
        ]),
      ),
    ).rejects.toThrow(/cover_need_fixed/);
    await expect(asPlanner((c) => c.query("DELETE FROM shift_cover_need"))).rejects.toThrow(
      /permission denied/,
    );
  });
});
