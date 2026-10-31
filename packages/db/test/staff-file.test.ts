import { SCHEDULE3_ITEMS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPLIANCE_ITEM_KINDS, REGISTRATION_BODIES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The staff profile and pre-employment file in the database (workforce.md sections 2a and 3;
 * WORK-002, WORK-011; migration 0073): cross-tenant denial; read by holders of the staff file
 * permissions of any scope (HR's role has none) and by the worker for their own file only;
 * written by holders of manage, never on their own file; evidence verified in the verifier's own
 * name; the DBS risk assessment signed only by a holder of the sign permission; nothing deleted;
 * and HR-only documents seen and added only by holders of workforce.hr_document.read.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** HR (a role with no person scope): read, manage and HR-only documents. */
const asHr = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** The North House Registered Manager: read, manage and sign, no HR-only documents. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** The care worker, with workforce.self.read only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "none"), fn);

const CARER_FILE = "0199f100-0000-7000-8000-0000000000a1";
const NORTH_FILE = "0199f100-0000-7000-8000-0000000000a2";
const B_FILE = "0199f100-0000-7000-8000-0000000000b1";
const CARER_DBS = "0199f100-0000-7000-8000-0000000000c1";
const CARER_ID = "0199f100-0000-7000-8000-0000000000c2";
const B_ID = "0199f100-0000-7000-8000-0000000000c3";
const HR_DOC = "0199f100-0000-7000-8000-0000000000d1";
const SOUTH_FILE = "0199f100-0000-7000-8000-0000000000a3";
const SOUTH_DBS = "0199f100-0000-7000-8000-0000000000c4";
const SOUTH_DOC = "0199f100-0000-7000-8000-0000000000d3";

const insertProfile = (c: pg.PoolClient, id: string, member: string, at: string | null = null) =>
  c.query(
    `INSERT INTO staff_profile (id, tenant_user_id, location_id, job_title, starts_on)
     VALUES ($1, $2, $3, 'Care worker', '2026-09-01')`,
    [id, member, at],
  );
const identity = JSON.stringify({ kind: "identity_with_photo", document: "passport" });
const dbs = JSON.stringify({
  kind: "dbs_certificate",
  certificate: null,
  updateService: null,
  barredListClearOn: "2026-08-10",
});
const insertItem = (
  c: pg.PoolClient,
  values: { id?: string; profile: string; kind: string; detail: string; verifiedBy?: string },
) =>
  c.query(
    `INSERT INTO compliance_item (id, staff_profile_id, kind, detail, verified_on, verified_by)
     VALUES (COALESCE($1, app.uuid_v7()), $2, $3, $4::jsonb,
       CASE WHEN $5::uuid IS NULL THEN NULL ELSE DATE '2026-08-20' END, $5)`,
    [values.id ?? null, values.profile, values.kind, values.detail, values.verifiedBy ?? null],
  );
const insertHrDocument = (c: pg.PoolClient, id: string, subjectId: string) =>
  c.query(
    `INSERT INTO document (id, category, title, retention_class, storage_key, content_type,
       size_bytes, sha256, subject_type, subject_id)
     VALUES ($1, 'staff_hr_document', 'Passport', 'staff_file', $3, 'application/pdf',
       10, repeat('a', 64), 'compliance_item', $2)`,
    [id, subjectId, `${id}/blob`],
  );
const count = async (c: pg.PoolClient, sql: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(sql, params)).rows[0]?.n);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f100-0000-7000-8000-000000000501', 'hr', 'HR', 'none',
          '{workforce.staff_file.read,workforce.staff_file.manage,workforce.hr_document.read}'),
         ('0199f100-0000-7000-8000-000000000502', 'registered_manager', 'Registered Manager', 'location',
          '{workforce.staff_file.read,workforce.staff_file.manage,workforce.dbs_risk_assessment.sign}'),
         ('0199f100-0000-7000-8000-000000000503', 'self', 'Self', 'assigned',
          '{workforce.self.read,workforce.staff_file.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f100-0000-7000-8000-000000000501', NULL),
         ($2, '0199f100-0000-7000-8000-000000000502', $3),
         ($4, '0199f100-0000-7000-8000-000000000503', $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f100-0000-7000-8000-000000000504', 'hr', 'HR', 'none',
          '{workforce.staff_file.read,workforce.staff_file.manage,workforce.hr_document.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       VALUES ($1, '0199f100-0000-7000-8000-000000000504')`,
      [b.manager],
    );
  });
  await asHr(async (c) => {
    await insertProfile(c, CARER_FILE, a.carer, a.locationNorth);
    await insertProfile(c, NORTH_FILE, a.northManager, a.locationNorth);
    await insertItem(c, {
      id: CARER_DBS,
      profile: CARER_FILE,
      kind: "dbs_certificate",
      detail: dbs,
    });
    await insertItem(c, {
      id: CARER_ID,
      profile: CARER_FILE,
      kind: "identity_with_photo",
      detail: identity,
      verifiedBy: a.manager,
    });
    await insertHrDocument(c, HR_DOC, CARER_ID);
  });
  // HR's own file, at South House, made by the North House manager.
  await asNorth(async (c) => {
    await insertProfile(c, SOUTH_FILE, a.manager, a.locationSouth);
    await insertItem(c, {
      id: SOUTH_DBS,
      profile: SOUTH_FILE,
      kind: "dbs_certificate",
      detail: dbs,
    });
  });
  await asOwner(TENANT_A, (c) => insertHrDocument(c, SOUTH_DOC, SOUTH_DBS));
  await asOtherTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT id FROM tenant_user WHERE id <> $1 LIMIT 1",
      [b.manager],
    );
    await insertProfile(c, B_FILE, rows[0]?.id ?? "");
    await insertItem(c, {
      id: B_ID,
      profile: B_FILE,
      kind: "identity_with_photo",
      detail: identity,
    });
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("the staff file schema is in step with packages/domain", () => {
  it("lists the Schedule 3 items and registers", () => {
    expect([...COMPLIANCE_ITEM_KINDS]).toEqual([...SCHEDULE3_ITEMS]);
    expect([...REGISTRATION_BODIES]).toEqual(["nmc", "hcpc", "swe", "gmc"]);
  });
});

describe("hazard HZ-011 staff files stay in their organisation", () => {
  it("never shows another organisation's profiles, items or HR documents", async () => {
    const seen = await asOtherTenant(async (c) => ({
      profiles: await count(c, "SELECT count(*) AS n FROM staff_profile WHERE tenant_id <> $1", [
        TENANT_B,
      ]),
      items: await count(c, "SELECT count(*) AS n FROM compliance_item WHERE tenant_id <> $1", [
        TENANT_B,
      ]),
      documents: await count(c, "SELECT count(*) AS n FROM document WHERE id = $1", [HR_DOC]),
    }));
    expect(seen).toEqual({ profiles: 0, items: 0, documents: 0 });
  });

  it("refuses an item on another organisation's profile", async () => {
    await expect(
      asOtherTenant((c) =>
        insertItem(c, {
          profile: CARER_FILE,
          kind: "references",
          detail: '{"kind":"references","received":1}',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("who reads and writes a staff file (workforce.md section 3)", () => {
  it("lets HR, whose role reaches no people, read and write every file", async () => {
    const seen = await asHr(async (c) =>
      count(c, "SELECT count(*) AS n FROM staff_profile WHERE id IN ($1, $2)", [
        CARER_FILE,
        NORTH_FILE,
      ]),
    );
    expect(seen).toBe(2);
  });

  it("lets a role scoped to assigned people read only the worker's own file, whatever it holds", async () => {
    const seen = await asCarer((c) => count(c, "SELECT count(*) AS n FROM staff_profile"));
    expect(seen).toBe(1);
  });

  it("verifies changed details again in the name of whoever changed them", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `UPDATE compliance_item SET detail = '{"kind":"identity_with_photo","document":"other_photo_document"}'
           WHERE id = $1`,
          [CARER_ID],
        ),
      ),
    ).rejects.toThrow(/verified again/);
  });

  it("keeps earlier versions of staff files from everyone who cannot read them", async () => {
    const versions = (fn: typeof asHr) =>
      fn((c) =>
        count(c, "SELECT count(*) AS n FROM record_version WHERE table_name = 'compliance_item'"),
      );
    await asHr((c) =>
      c.query(
        `UPDATE compliance_item SET detail = '{"kind":"identity_with_photo","document":"passport"}', verified_by = $2
         WHERE id = $1`,
        [CARER_ID, a.manager],
      ),
    );
    expect(await versions(asHr)).toBeGreaterThan(0);
    const other = (fn: (c: pg.PoolClient) => Promise<number>) =>
      inContext(app(), ctx(TENANT_A, ids.a.carer, "none"), fn);
    await asOwner(TENANT_A, (c) =>
      c.query(
        "UPDATE role SET permissions = '{workforce.self.read}' WHERE id = '0199f100-0000-7000-8000-000000000503'",
      ),
    );
    try {
      expect(
        await other((c) =>
          count(c, "SELECT count(*) AS n FROM record_version WHERE table_name = 'compliance_item'"),
        ),
      ).toBe(0);
    } finally {
      await asOwner(TENANT_A, (c) =>
        c.query(
          "UPDATE role SET permissions = '{workforce.self.read,workforce.staff_file.read}' WHERE id = '0199f100-0000-7000-8000-000000000503'",
        ),
      );
    }
  });

  it("lets a location's manager read files across the organisation (HR functions are organisation-wide)", async () => {
    const seen = await asNorth(async (c) => ({
      profiles: await count(c, "SELECT count(*) AS n FROM staff_profile"),
      items: await count(
        c,
        "SELECT count(*) AS n FROM compliance_item WHERE staff_profile_id = $1",
        [CARER_FILE],
      ),
    }));
    expect(seen).toEqual({ profiles: 3, items: 2 });
  });

  it("shows the worker their own file only, and never lets them write it", async () => {
    const seen = await asCarer(async (c) => ({
      profiles: (await c.query<{ id: string }>("SELECT id FROM staff_profile")).rows.map(
        (r) => r.id,
      ),
      items: await count(c, "SELECT count(*) AS n FROM compliance_item"),
    }));
    expect(seen).toEqual({ profiles: [CARER_FILE], items: 2 });
    await expect(
      asCarer((c) =>
        insertItem(c, {
          profile: CARER_FILE,
          kind: "references",
          detail: '{"kind":"references","received":3}',
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    const changed = await asCarer(
      async (c) =>
        (
          await c.query("UPDATE staff_profile SET job_title = 'Manager' WHERE id = $1", [
            CARER_FILE,
          ])
        ).rowCount,
    );
    expect(changed).toBe(0);
  });

  it("never lets a holder of manage write their own file", async () => {
    await expect(
      asNorth((c) =>
        insertItem(c, {
          profile: NORTH_FILE,
          kind: "references",
          detail: '{"kind":"references","received":2}',
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asNorth((c) => insertProfile(c, CARER_FILE.replace("a1", "a9"), a.northManager)),
    ).rejects.toThrow(/row-level security/);
  });

  it("verifies evidence only in the verifier's own name", async () => {
    await expect(
      asHr((c) =>
        insertItem(c, {
          profile: CARER_FILE,
          kind: "references",
          detail: '{"kind":"references","received":2}',
          verifiedBy: a.northManager,
        }),
      ),
    ).rejects.toThrow(/in their own name/);
  });

  it("keeps an item's kind and profile, and the detail's kind with the row's", async () => {
    await expect(
      asHr((c) =>
        c.query("UPDATE compliance_item SET kind = 'references' WHERE id = $1", [CARER_ID]),
      ),
    ).rejects.toThrow();
    await expect(
      asHr((c) => insertItem(c, { profile: NORTH_FILE, kind: "references", detail: identity })),
    ).rejects.toThrow(/compliance_item_detail/);
  });

  it("deletes nothing", async () => {
    await expect(
      asOwner(TENANT_A, (c) => c.query("DELETE FROM compliance_item WHERE id = $1", [CARER_ID])),
    ).rejects.toThrow();
  });

  it("keeps each earlier version of a changed item", async () => {
    await asHr((c) =>
      c.query(
        `UPDATE compliance_item SET detail = '{"kind":"identity_with_photo","document":"photocard_driving_licence"}'
         WHERE id = $1`,
        [CARER_ID],
      ),
    );
    const versions = await asOwner(TENANT_A, (c) =>
      count(c, "SELECT count(*) AS n FROM record_version WHERE record_id = $1", [CARER_ID]),
    );
    expect(versions).toBeGreaterThanOrEqual(1);
  });
});

describe("the DBS risk assessment (workforce.md rule 3)", () => {
  const sign = (c: pg.PoolClient, signer: string) =>
    c.query(
      `UPDATE compliance_item SET risk_assessment_signed_on = DATE '2026-08-11',
         risk_assessment_signed_by = $2 WHERE id = $1`,
      [CARER_DBS, signer],
    );

  it("is not signed by HR without the sign permission", async () => {
    await expect(asHr((c) => sign(c, a.manager))).rejects.toThrow(/dbs_risk_assessment.sign/);
  });

  it("is not signed in someone else's name", async () => {
    await expect(asNorth((c) => sign(c, a.manager))).rejects.toThrow(/in their own name/);
  });

  it("is signed by a holder of the sign permission in their own name", async () => {
    await asNorth((c) => sign(c, a.northManager));
    const signed = await asHr(
      async (c) =>
        (
          await c.query<{ by: string }>(
            "SELECT risk_assessment_signed_by AS by FROM compliance_item WHERE id = $1",
            [CARER_DBS],
          )
        ).rows[0]?.by,
    );
    expect(signed).toBe(a.northManager);
  });

  it("is not signed for a worker at another home by a location's manager", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `UPDATE compliance_item SET risk_assessment_signed_on = DATE '2026-08-11',
             risk_assessment_signed_by = $2 WHERE id = $1`,
          [SOUTH_DBS, a.northManager],
        ),
      ),
    ).rejects.toThrow(/dbs_risk_assessment.sign/);
  });

  it("is never unsigned", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `UPDATE compliance_item SET risk_assessment_signed_on = NULL, risk_assessment_signed_by = NULL
           WHERE id = $1`,
          [CARER_DBS],
        ),
      ),
    ).rejects.toThrow(/not unsigned/);
  });

  it("belongs to a DBS item only", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `UPDATE compliance_item SET risk_assessment_signed_on = DATE '2026-08-11',
             risk_assessment_signed_by = $2 WHERE id = $1`,
          [CARER_ID, a.northManager],
        ),
      ),
    ).rejects.toThrow(/compliance_item_risk_assessment/);
  });
});

describe("HR-only staff documents (workforce.md section 3)", () => {
  it("are seen only by holders of workforce.hr_document.read", async () => {
    const seen = await Promise.all([
      asHr((c) => count(c, "SELECT count(*) AS n FROM document WHERE id = $1", [HR_DOC])),
      asNorth((c) => count(c, "SELECT count(*) AS n FROM document WHERE id = $1", [HR_DOC])),
      asCarer((c) => count(c, "SELECT count(*) AS n FROM document WHERE id = $1", [HR_DOC])),
    ]);
    expect(seen).toEqual([1, 0, 0]);
  });

  it("are hidden from HR on their own file", async () => {
    expect(
      await asHr((c) => count(c, "SELECT count(*) AS n FROM document WHERE id = $1", [SOUTH_DOC])),
    ).toBe(0);
  });

  it("are added only by a holder of it and of manage, to a compliance item of someone else's file", async () => {
    await expect(
      asNorth((c) => insertHrDocument(c, HR_DOC.replace("d1", "d2"), CARER_ID)),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asHr((c) =>
        c.query(
          `INSERT INTO document (category, title, retention_class, storage_key, content_type,
             size_bytes, sha256, subject_type, subject_id)
           VALUES ('staff_hr_document', 'Loose', 'staff_file', 'x/blob', 'application/pdf', 10,
             repeat('a', 64), 'location', $1)`,
          [a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
