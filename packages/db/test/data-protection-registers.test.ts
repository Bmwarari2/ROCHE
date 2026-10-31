import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The breach register and data protection complaints in the database (PLAT-022; platform.md rules
 * 18 to 26; migration 0082; hazard HZ-011): read and written only with quality.dsar.manage, never
 * across organisations, never deleted; Thapsus's notices and their acknowledgements append-only;
 * closed records never change; and Thapsus sends a notice only through its definer function, as
 * an active admin, opening the organisation's register entry and writing its audit and outbox.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_DPO = "0199f000-0000-7000-8000-000000000a01";
const ROLE_DPO_B = "0199f000-0000-7000-8000-000000000a02";
let admin = "";
let support = "";
const app = () => db.pool("harbour_app");
const asMember =
  (userId: string, tenant = TENANT_A) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(tenant, userId, "tenant"), fn);
const asDpo = asMember(a.manager);
const asCarer = asMember(a.carer);
const asOtherDpo = asMember(ids.b.manager, TENANT_B);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const BREACH =
  "INSERT INTO dp_breach (source, summary, aware_at) VALUES ('tenant', 'A letter went to the wrong address.', now()) RETURNING id";
const COMPLAINT = `INSERT INTO dp_complaint (received_on, channel, complainant_kind, complainant_name, about, summary)
  VALUES ('2026-10-01', 'email', 'family', 'Eve Example', 'access', 'They asked for records and heard nothing.') RETURNING id`;

/** Sends a processor notice as an operator, the way the console does. */
const send = (operator: string, follows: string | null = null, tenant = TENANT_A) =>
  inContext(db.pool("harbour_operator"), null, async (c) => {
    await c.query("SELECT set_config('app.operator_id', $1, true)", [operator]);
    const { rows } = await c.query<{ r: { noticeId: string; breachId: string } }>(
      `SELECT app.send_processor_breach_notice($1, $2, 'A misconfigured export exposed files briefly.',
         'Care notes and names', 12, 40, 'Possible distress', 'Access closed and logs reviewed',
         'Check whether to report to the ICO', 'dpo@thapsus.example.invalid', 'req-1') AS r`,
      [tenant, follows],
    );
    const result = rows[0]?.r;
    if (!result) throw new Error("no result");
    return result;
  });

beforeAll(async () => {
  db = await createTestDatabase();
  const owner = db.pool("harbour_owner");
  await seedTwoTenants(owner);
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'dpo', 'Data protection lead', 'tenant', '{quality.dsar.manage}')`,
      [ROLE_DPO],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE_DPO,
    ]);
  });
  await inContext(owner, ctx(TENANT_B, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'dpo', 'Data protection lead', 'tenant', '{quality.dsar.manage}')`,
      [ROLE_DPO_B],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      ids.b.manager,
      ROLE_DPO_B,
    ]);
  });
  const { rows } = await owner.query<{ id: string; role: string }>(
    `INSERT INTO operator_user (auth_user_id, display_name, role) VALUES
       ('auth-dp-admin', 'Ola Operator', 'admin'), ('auth-dp-support', 'Sam Support', 'support')
     RETURNING id, role`,
  );
  admin = rows.find((r) => r.role === "admin")?.id ?? "";
  support = rows.find((r) => r.role === "support")?.id ?? "";
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 the breach register (migration 0082)", () => {
  it("records, changes and versions a breach with quality.dsar.manage, and never deletes it", async () => {
    const { rows } = await asDpo((c) => c.query<{ id: string }>(BREACH));
    const id = rows[0]?.id;
    await asDpo((c) =>
      c.query("UPDATE dp_breach SET occurred_at = now() - interval '1 day' WHERE id = $1", [id]),
    );
    const after = await ownerDb((c) =>
      c.query("SELECT version, created_by FROM dp_breach WHERE id = $1", [id]),
    );
    expect(after.rows).toEqual([{ version: 2, created_by: a.manager }]);
    await expect(asDpo((c) => c.query("DELETE FROM dp_breach"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("refuses anyone without quality.dsar.manage, and every other organisation", async () => {
    await expect(asCarer((c) => c.query(BREACH))).rejects.toThrow(/row-level security/);
    expect((await asCarer((c) => c.query("SELECT id FROM dp_breach"))).rowCount).toBe(0);
    expect((await asOtherDpo((c) => c.query("SELECT id FROM dp_breach"))).rowCount).toBe(0);
    await expect(
      asOtherDpo((c) =>
        c.query(
          "INSERT INTO dp_breach (tenant_id, source, summary, aware_at) VALUES ($1, 'tenant', 'Cross-organisation write.', now())",
          [TENANT_A],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/);
  });

  it("refuses a processor entry from the application, and a decision without reasoning", async () => {
    await expect(
      asDpo((c) =>
        c.query(
          "INSERT INTO dp_breach (source, summary, aware_at) VALUES ('processor_notice', 'Pretending to be Thapsus.', now())",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const { rows } = await asDpo((c) => c.query<{ id: string }>(BREACH));
    await expect(
      asDpo((c) =>
        c.query(
          `UPDATE dp_breach SET report_to_ico = false, tell_individuals = false, decided_by = $2,
             decided_at = now(), decision_reasoning = 'too short' WHERE id = $1`,
          [rows[0]?.id, a.manager],
        ),
      ),
    ).rejects.toThrow(/dp_breach_decided/);
  });

  it("needs a decision to report before an ICO report, keeps awareness fixed after it, and freezes a closed entry", async () => {
    const { rows } = await asDpo((c) => c.query<{ id: string }>(BREACH));
    const id = rows[0]?.id;
    await expect(
      asDpo((c) =>
        c.query("UPDATE dp_breach SET reported_at = now(), ico_reference = 'IC-1' WHERE id = $1", [
          id,
        ]),
      ),
    ).rejects.toThrow(/dp_breach_reported/);
    await asDpo((c) =>
      c.query(
        `UPDATE dp_breach SET factors = '{}'::jsonb, suggested_severity = 'medium',
           suggested_report_to_ico = true, suggested_tell_individuals = false, assessed_by = $2,
           assessed_at = now(), report_to_ico = true, tell_individuals = false, decided_by = $2,
           decided_at = now(), decision_reasoning = 'Special category data reached a stranger.'
         WHERE id = $1`,
        [id, a.manager],
      ),
    );
    await asDpo((c) =>
      c.query("UPDATE dp_breach SET reported_at = now(), ico_reference = 'IC-1' WHERE id = $1", [
        id,
      ]),
    );
    await expect(
      asDpo((c) =>
        c.query("UPDATE dp_breach SET aware_at = aware_at - interval '1 hour' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/dp_breach_aware_at_after_report/);
    await asDpo((c) =>
      c.query(
        `UPDATE dp_breach SET status = 'closed', closed_by = $2, closed_at = now(),
           lessons = 'Check addresses against the record before posting.' WHERE id = $1`,
        [id, a.manager],
      ),
    );
    await expect(
      asDpo((c) =>
        c.query("UPDATE dp_breach SET summary = 'Changed afterwards.' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/dp_breach_closed/);
  });
});

describe("hazard HZ-011 processor breach notices (migration 0082, rule 24)", () => {
  it("lets only an active admin send one, opening the organisation's register entry", async () => {
    await expect(send(support)).rejects.toThrow(/operator_not_admin/);
    const sent = await send(admin);
    const entry = await asDpo((c) =>
      c.query("SELECT source, created_by FROM dp_breach WHERE id = $1", [sent.breachId]),
    );
    expect(entry.rows).toEqual([{ source: "processor_notice", created_by: null }]);
    const audit = await ownerDb((c) =>
      c.query("SELECT action, scope FROM audit_event WHERE resource_id = $1 AND tenant_id = $2", [
        sent.noticeId,
        TENANT_A,
      ]),
    );
    expect(audit.rows[0]?.action).toBe("platform.breach.processor_notice_sent");
    expect(JSON.stringify(audit.rows[0]?.scope)).not.toMatch(/export|Care notes/);
    const outbox = await ownerDb((c) =>
      c.query("SELECT event_type FROM outbox_event WHERE aggregate_id = $1", [sent.noticeId]),
    );
    expect(outbox.rows).toEqual([{ event_type: "platform.breach.processor_notice_sent" }]);
    // A follow-up joins the same entry; another organisation's notice cannot be followed up here.
    const later = await send(admin, sent.noticeId);
    expect(later.breachId).toBe(sent.breachId);
    await expect(send(admin, sent.noticeId, TENANT_B)).rejects.toThrow(/notice_not_found/);
  });

  it("is never written, changed or seen outside its organisation, and acknowledged once in one's own name", async () => {
    const sent = await send(admin);
    await expect(
      asDpo((c) =>
        c.query(
          `INSERT INTO processor_breach_notice (breach_id, nature, data_categories, likely_consequences,
             measures, tenant_actions, contact, sent_by_operator)
           VALUES ($1, 'Pretend notice text.', 'none', 'none', 'none', 'none', 'none', $2)`,
          [sent.breachId, admin],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(
      (await asOtherDpo((c) => c.query("SELECT id FROM processor_breach_notice"))).rowCount,
    ).toBe(0);
    expect((await asCarer((c) => c.query("SELECT id FROM processor_breach_notice"))).rowCount).toBe(
      0,
    );
    await expect(
      asDpo((c) =>
        c.query(
          "INSERT INTO processor_breach_notice_ack (notice_id, acknowledged_by) VALUES ($1, $2)",
          [sent.noticeId, a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await asDpo((c) =>
      c.query("INSERT INTO processor_breach_notice_ack (notice_id) VALUES ($1)", [sent.noticeId]),
    );
    await expect(
      asDpo((c) =>
        c.query("INSERT INTO processor_breach_notice_ack (notice_id) VALUES ($1)", [sent.noticeId]),
      ),
    ).rejects.toThrow(/processor_breach_notice_ack_notice_key/);
    await expect(
      ownerDb((c) => c.query("DELETE FROM processor_breach_notice_ack")),
    ).rejects.toThrow(/append-only/);
    await expect(
      ownerDb((c) => c.query("UPDATE processor_breach_notice SET contact = 'x'")),
    ).rejects.toThrow(/append-only/);
  });
});

describe("hazard HZ-011 data protection complaints (migration 0082, rule 25)", () => {
  it("records and closes a complaint with quality.dsar.manage only, then freezes it", async () => {
    await expect(asCarer((c) => c.query(COMPLAINT))).rejects.toThrow(/row-level security/);
    const { rows } = await asDpo((c) => c.query<{ id: string }>(COMPLAINT));
    const id = rows[0]?.id;
    expect((await asOtherDpo((c) => c.query("SELECT id FROM dp_complaint"))).rowCount).toBe(0);
    await expect(
      asDpo((c) =>
        c.query("UPDATE dp_complaint SET acknowledged_on = '2026-09-30' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/dp_complaint_dates/);
    await expect(
      asDpo((c) =>
        c.query(
          `UPDATE dp_complaint SET status = 'closed', closed_on = '2026-10-20', closed_by = $2,
             outcome = 'We sent the records and apologised for the delay.' WHERE id = $1`,
          [id, a.manager],
        ),
      ),
    ).rejects.toThrow(/dp_complaint_closed/);
    await asDpo((c) =>
      c.query(
        `UPDATE dp_complaint SET status = 'closed', closed_on = '2026-10-20', closed_by = $2,
           ico_right_stated = true,
           outcome = 'We sent the records and apologised; you may complain to the ICO.' WHERE id = $1`,
        [id, a.manager],
      ),
    );
    await expect(
      asDpo((c) =>
        c.query("UPDATE dp_complaint SET summary = 'Changed afterwards.' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/dp_complaint_closed/);
    await expect(asDpo((c) => c.query("DELETE FROM dp_complaint"))).rejects.toThrow(
      /permission denied/,
    );
  });
});
