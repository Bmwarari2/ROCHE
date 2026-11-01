import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Sponsor licence records, staff data protection and LDSS in the database (workforce.md section
 * 12; slice 35; migration 0097): cross-tenant denial, sponsor records HR only and never one's own,
 * a member's own privacy acknowledgements and image consent (append-only), LDSS claims for holders
 * of workforce.ldss.manage, earlier versions hidden like the records. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** HR: holds the sponsor and LDSS permissions across the organisation. */
const asHr = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** The sponsored worker themselves. */
const asWorker = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);

const sponsor = (c: pg.PoolClient, member: string) =>
  c.query<{ id: string }>(
    `INSERT INTO sponsored_worker (tenant_user_id, cos_reference, cos_assigned_on, soc_code, route,
       visa_expires_on, contracted_weekly_hours, guaranteed_yearly_pay)
     VALUES ($1, 'C2X0000001', '2028-01-10', '6145', 'health_and_care_worker', '2031-01-10', 37.5, 26000)
     RETURNING id`,
    [member],
  );

let worker = "";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199e000-0000-7000-8000-000000000a01', 'hr', 'HR', 'tenant',
         '{workforce.immigration.read,workforce.sponsor.manage,workforce.ldss.manage,workforce.staff_file.read}')`,
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, '0199e000-0000-7000-8000-000000000a01')",
      [a.manager],
    );
  });
  worker = (await asHr((c) => sponsor(c, a.carer))).rows[0]?.id as string;
});

afterAll(async () => {
  await db?.drop();
});

describe("WORK-003 sponsor records are HR only, never one's own, and stay in their organisation", () => {
  it("are invisible to another organisation", async () => {
    expect((await asOtherTenant((c) => c.query("SELECT id FROM sponsored_worker"))).rows).toEqual(
      [],
    );
  });

  it("are hidden from the sponsored worker themselves, and HR cannot sponsor themselves", async () => {
    expect((await asWorker((c) => c.query("SELECT id FROM sponsored_worker"))).rows).toEqual([]);
    await expect(asHr((c) => sponsor(c, a.manager))).rejects.toThrow(/row-level security/);
  });

  it("record absences and reports for HR, with the shape checked", async () => {
    await asHr((c) =>
      c.query(
        "INSERT INTO sponsor_absence (sponsored_worker_id, from_on, to_on, authorised) VALUES ($1, '2028-11-06', '2028-11-20', false)",
        [worker],
      ),
    );
    await expect(
      asHr((c) =>
        c.query(
          "INSERT INTO sponsor_report (sponsored_worker_id, kind, happened_on, reported_on) VALUES ($1, 'unauthorised_absence', '2028-11-20', '2028-11-25')",
          [worker],
        ),
      ),
    ).rejects.toThrow(/sponsor_report_reported/);
    await asHr((c) =>
      c.query(
        "INSERT INTO sponsor_report (sponsored_worker_id, kind, happened_on) VALUES ($1, 'unauthorised_absence', '2028-11-20')",
        [worker],
      ),
    );
    expect((await asWorker((c) => c.query("SELECT id FROM sponsor_report"))).rows).toEqual([]);
    expect((await asWorker((c) => c.query("SELECT id FROM sponsor_absence"))).rows).toEqual([]);
  });

  it("are read by the organisation's own system context (export, DSAR collector)", async () => {
    expect((await asSystem((c) => c.query("SELECT id FROM sponsored_worker"))).rows).toHaveLength(
      1,
    );
  });

  it("keep earlier versions as hidden as the records", async () => {
    await asHr((c) =>
      c.query("UPDATE sponsored_worker SET soc_code = '6146' WHERE id = $1", [worker]),
    );
    const seen = (fn: typeof asHr) =>
      fn((c) => c.query("SELECT 1 FROM record_version WHERE table_name = 'sponsored_worker'"));
    expect((await seen(asHr)).rows.length).toBeGreaterThan(0);
    expect((await seen(asWorker)).rows).toEqual([]);
  });

  it("are never deleted", async () => {
    await expect(asHr((c) => c.query("DELETE FROM sponsor_report"))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("WORK-011 a member's own privacy acknowledgements and image consent", () => {
  it("are made by the member for themselves only, and kept as made", async () => {
    await asWorker((c) =>
      c.query(
        "INSERT INTO staff_privacy_acknowledgement (tenant_user_id, notice_version) VALUES ($1, '2028-01')",
        [a.carer],
      ),
    );
    await expect(
      asHr((c) =>
        c.query(
          "INSERT INTO staff_privacy_acknowledgement (tenant_user_id, notice_version) VALUES ($1, '2028-02')",
          [a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await asWorker((c) =>
      c.query(
        "INSERT INTO staff_image_consent (tenant_user_id, purpose, decision) VALUES ($1, 'newsletter', 'given')",
        [a.carer],
      ),
    );
    await expect(
      asWorker((c) => c.query("UPDATE staff_image_consent SET decision = 'refused'")),
    ).rejects.toThrow();
    // HR with the staff file permission can read them.
    expect((await asHr((c) => c.query("SELECT id FROM staff_image_consent"))).rows).toHaveLength(1);
    expect(
      (await asOtherTenant((c) => c.query("SELECT id FROM staff_image_consent"))).rows,
    ).toEqual([]);
  });
});

describe("WORK-007 LDSS claims", () => {
  it("are kept by holders of workforce.ldss.manage and seen by the member", async () => {
    await asHr((c) =>
      c.query(
        "INSERT INTO ldss_claim (tenant_user_id, course_title) VALUES ($1, 'Level 2 Adult Social Care Certificate')",
        [a.carer],
      ),
    );
    await expect(
      asWorker((c) =>
        c.query("INSERT INTO ldss_claim (tenant_user_id, course_title) VALUES ($1, 'x')", [
          a.carer,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    expect((await asWorker((c) => c.query("SELECT id FROM ldss_claim"))).rows).toHaveLength(1);
    await expect(
      asHr((c) => c.query("UPDATE ldss_claim SET status = 'submitted'")),
    ).rejects.toThrow(/ldss_claim_states/);
  });
});
