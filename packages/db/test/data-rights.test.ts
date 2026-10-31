import { DSAR_MEMBER_SCOPED_TABLES, dsarSubjectMap, EXPORT_TABLES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The DSAR workbench in the database (PLAT-022; platform.md, Phase 2: the DSAR workbench; ADR-0090;
 * migration 0077): cross-tenant denial, cases and items only for holders of quality.dsar.manage,
 * one subject of the case's kind, a representative's authority, no deletion, a closed case that
 * never changes and items decided only while their case is open. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const CONTACT_EVE = "0199e000-0000-7000-8000-0000000007c1";

const newCase = (c: pg.PoolClient) =>
  c.query<{ id: string }>(
    `INSERT INTO dsar_case (request_kind, subject_kind, subject_person_id, requester_kind, channel,
       received_on)
     VALUES ('access', 'person', $1, 'subject', 'email', '2026-10-01') RETURNING id`,
    [a.personAda],
  );

let caseA: string;
let caseB: string;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199e000-0000-7000-8000-000000000771', 'quality_lead', 'Quality lead', 'tenant',
         '{quality.dsar.manage,people.person.read}')`,
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, '0199e000-0000-7000-8000-000000000771')",
      [a.manager],
    );
    await c.query(
      `INSERT INTO contact (id, person_id, role, given_name, family_name)
       VALUES ($1, $2, 'next_of_kin', 'Eve', 'Example')`,
      [CONTACT_EVE, a.personAda],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199e000-0000-7000-8000-000000000772', 'quality_lead', 'Quality lead', 'tenant',
         '{quality.dsar.manage}')`,
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, '0199e000-0000-7000-8000-000000000772')",
      [b.manager],
    );
  });
  caseB = (
    await asOtherTenant((c) =>
      c.query<{ id: string }>(
        `INSERT INTO dsar_case (request_kind, subject_kind, subject_person_id, requester_kind, channel, received_on)
         VALUES ('access', 'person', $1, 'subject', 'post', '2026-10-01') RETURNING id`,
        [b.personDev],
      ),
    )
  ).rows[0]?.id as string;
  // A location-scoped manager who holds quality.dsar.manage only at North (#149 H1).
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199e000-0000-7000-8000-000000000773', 'deputy_manager', 'Deputy', 'location',
         '{quality.dsar.manage,people.person.read}')`,
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, '0199e000-0000-7000-8000-000000000773', $2)",
      [a.northManager, a.locationNorth],
    );
  });
  caseA = (await asLead((c) => newCase(c))).rows[0]?.id as string;
});

afterAll(async () => {
  await db?.drop();
});

describe("PLAT-022 a DSAR case stays in its tenant", () => {
  it("is invisible to another tenant, even by id", async () => {
    const seen = await asOtherTenant((c) =>
      c.query("SELECT id FROM dsar_case WHERE id = $1", [caseA]),
    );
    expect(seen.rows).toEqual([]);
    const own = await asLead((c) => c.query("SELECT id FROM dsar_case"));
    expect(own.rows.map((r) => r.id)).toEqual([caseA]);
    expect(own.rows.map((r) => r.id)).not.toContain(caseB);
  });

  it("cannot be written into another tenant, or changed there", async () => {
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO dsar_case (tenant_id, request_kind, subject_kind, subject_person_id, requester_kind, channel, received_on)
           VALUES ($1, 'access', 'person', $2, 'subject', 'post', '2026-10-01')`,
          [TENANT_A, a.personAda],
        ),
      ),
    ).rejects.toThrow();
    const changed = await asOtherTenant((c) =>
      c.query("UPDATE dsar_case SET channel = 'phone' WHERE id = $1", [caseA]),
    );
    expect(changed.rowCount).toBe(0);
  });

  it("cannot name another tenant's person as its subject", async () => {
    await expect(
      asLead((c) =>
        c.query(
          `INSERT INTO dsar_case (request_kind, subject_kind, subject_person_id, requester_kind, channel, received_on)
           VALUES ('access', 'person', $1, 'subject', 'post', '2026-10-01')`,
          [b.personDev],
        ),
      ),
    ).rejects.toThrow(/dsar_case_person_fk/);
  });

  it("keeps items in their tenant, and never on another tenant's case", async () => {
    const item = await asLead((c) =>
      c.query<{ id: string }>(
        "INSERT INTO dsar_item (case_id, table_name, record_id) VALUES ($1, 'person', $2) RETURNING id",
        [caseA, a.personAda],
      ),
    );
    expect(item.rows).toHaveLength(1);
    const seen = await asOtherTenant((c) => c.query("SELECT id FROM dsar_item"));
    expect(seen.rows).toEqual([]);
    await expect(
      asLead((c) =>
        c.query(
          "INSERT INTO dsar_item (case_id, table_name, record_id) VALUES ($1, 'person', 'x')",
          [caseB],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("only holders of quality.dsar.manage see or write a case", () => {
  it("hides cases and items from a care worker", async () => {
    expect((await asCarer((c) => c.query("SELECT id FROM dsar_case"))).rows).toEqual([]);
    expect((await asCarer((c) => c.query("SELECT id FROM dsar_item"))).rows).toEqual([]);
    await expect(asCarer((c) => newCase(c))).rejects.toThrow(/row-level security/);
  });

  it("never deletes a case or an item", async () => {
    await expect(
      asLead((c) => c.query("DELETE FROM dsar_item WHERE case_id = $1", [caseA])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asLead((c) => c.query("DELETE FROM dsar_case WHERE id = $1", [caseA])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("the case's shape", () => {
  const insert = (values: string, params: unknown[]) =>
    asLead((c) =>
      c.query(
        `INSERT INTO dsar_case (request_kind, subject_kind, subject_person_id, subject_contact_id,
           subject_staff_id, requester_kind, requester_name, authority, channel, received_on)
         VALUES ${values}`,
        params,
      ),
    );

  // [name, subject kind, person, contact, staff, requester, authority, allowed]
  const P = () => a.personAda;
  const S = () => a.carer;
  it.each([
    [
      "a contact case with the contact",
      "contact",
      P,
      () => CONTACT_EVE,
      null,
      "subject",
      null,
      true,
    ],
    ["a contact case without the contact", "contact", P, null, null, "subject", null, false],
    ["a staff case naming a person", "staff", P, null, S, "subject", null, false],
    ["a staff case", "staff", null, null, S, "subject", null, true],
    [
      "a representative without an authority",
      "person",
      P,
      null,
      null,
      "representative",
      null,
      false,
    ],
    [
      "a representative with an LPA",
      "person",
      P,
      null,
      null,
      "representative",
      "lpa_health_welfare",
      true,
    ],
  ] as const)("%s", async (_name, kind, person, contact, staff, requester, authority, allowed) => {
    const run = insert("('access', $1, $2, $3, $4, $5, $6, $7, 'post', '2026-10-01')", [
      kind,
      person?.() ?? null,
      contact?.() ?? null,
      staff?.() ?? null,
      requester,
      requester === "representative" ? "Eve Example" : null,
      authority,
    ]);
    if (allowed) await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toThrow(/dsar_case_/);
  });

  it("refuses an extension beyond two months or without grounds", async () => {
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE dsar_case SET extension_months = 3, extension_grounds = 'complex', extension_reason = 'Many records', extension_decided_on = '2026-10-10' WHERE id = $1",
          [caseA],
        ),
      ),
    ).rejects.toThrow(/dsar_case_extension/);
    await expect(
      asLead((c) => c.query("UPDATE dsar_case SET extension_months = 2 WHERE id = $1", [caseA])),
    ).rejects.toThrow(/dsar_case_extension/);
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE dsar_case SET extension_months = 2, extension_reason = 'Many records', extension_decided_on = '2026-10-10' WHERE id = $1",
          [caseA],
        ),
      ),
    ).rejects.toThrow(/dsar_case_extension/);
  });

  it("needs a reason for a redaction or a withheld record, and the fields redacted", async () => {
    const item = (
      await asLead((c) =>
        c.query<{ id: string }>(
          "INSERT INTO dsar_item (case_id, table_name, record_id) VALUES ($1, 'contact', $2) RETURNING id",
          [caseA, CONTACT_EVE],
        ),
      )
    ).rows[0]?.id as string;
    const decide = (set: string) =>
      asLead((c) =>
        c.query(
          `UPDATE dsar_item SET ${set}, reviewed_by = app.current_user_id(), reviewed_at = now() WHERE id = $1`,
          [item],
        ),
      );
    await expect(decide("decision = 'withhold'")).rejects.toThrow(/dsar_item_redaction/);
    await expect(decide("decision = 'redact', reason = 'Third-party data'")).rejects.toThrow(
      /dsar_item_redaction/,
    );
    await expect(
      decide("decision = 'redact', redacted_fields = '{given_name}', reason = 'Third-party data'"),
    ).resolves.toBeDefined();
  });
});

describe("a closed case is the record of what was done", () => {
  it("never reopens, changes or takes new items", async () => {
    const closed = (await asLead((c) => newCase(c))).rows[0]?.id as string;
    await asLead((c) =>
      c.query(
        "UPDATE dsar_case SET status = 'closed', outcome = 'fulfilled', responded_on = '2026-10-20', identity_required = false WHERE id = $1",
        [closed],
      ),
    );
    await expect(
      asLead((c) =>
        c.query("UPDATE dsar_case SET status = 'open', outcome = NULL WHERE id = $1", [closed]),
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      asLead((c) =>
        c.query(
          "INSERT INTO dsar_item (case_id, table_name, record_id) VALUES ($1, 'person', $2)",
          [closed, a.personAda],
        ),
      ),
    ).rejects.toThrow(/not open/);
  });

  it("refuses a closed case without an outcome", async () => {
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE dsar_case SET status = 'closed', responded_on = '2026-10-20' WHERE id = $1",
          [caseA],
        ),
      ),
    ).rejects.toThrow(/dsar_case_outcome/);
  });

  it("refuses a refusal without reasons", async () => {
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE dsar_case SET status = 'closed', outcome = 'refused', responded_on = '2026-10-20' WHERE id = $1",
          [caseA],
        ),
      ),
    ).rejects.toThrow(/dsar_case_outcome_reason/);
  });
});

describe("#149 review: organisation-wide roles only, the owner role too, guards, identity", () => {
  it("H1: a manager holding the permission only at a location sees and writes nothing", async () => {
    expect((await asNorthManager((c) => c.query("SELECT id FROM dsar_case"))).rows).toEqual([]);
    await expect(asNorthManager((c) => newCase(c))).rejects.toThrow(/row-level security/);
  });

  it("L8: the owner role acting for a member without the role sees nothing", async () => {
    const rows = await inContext(
      db.pool("harbour_owner"),
      ctx(TENANT_A, a.carer, "locations", [a.locationNorth]),
      (c) => c.query("SELECT id FROM dsar_case"),
    );
    expect(rows.rows).toEqual([]);
  });

  it("the organisation's own system context (the full export) reads cases, and writes none", async () => {
    const job = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
    expect((await job((c) => c.query("SELECT id FROM dsar_case"))).rows.length).toBeGreaterThan(0);
    await expect(job((c) => newCase(c))).rejects.toThrow(/row-level security/);
  });

  it("L7: a closed case cannot be changed by also setting deleted_at, but may be soft-deleted", async () => {
    const closed = (await asLead((c) => newCase(c))).rows[0]?.id as string;
    await asLead((c) =>
      c.query(
        "UPDATE dsar_case SET status = 'closed', outcome = 'fulfilled', responded_on = '2026-10-20', identity_required = false WHERE id = $1",
        [closed],
      ),
    );
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE dsar_case SET outcome = 'refused', outcome_reason = 'x', deleted_at = now() WHERE id = $1",
          [closed],
        ),
      ),
    ).rejects.toThrow(/cannot change/);
    await expect(
      asLead((c) => c.query("UPDATE dsar_case SET deleted_at = now() WHERE id = $1", [closed])),
    ).resolves.toBeDefined();
  });

  it("L7: an item never moves to another case", async () => {
    const other = (await asLead((c) => newCase(c))).rows[0]?.id as string;
    const item = (
      await asLead((c) =>
        c.query<{ id: string }>(
          "INSERT INTO dsar_item (case_id, table_name, record_id) VALUES ($1, 'allergy', 'x1') RETURNING id",
          [caseA],
        ),
      )
    ).rows[0]?.id as string;
    await expect(
      asLead((c) => c.query("UPDATE dsar_item SET case_id = $1 WHERE id = $2", [other, item])),
    ).rejects.toThrow(/keeps its case/);
  });

  it("M4: a case awaiting identity cannot close as done or carry a bundle", async () => {
    const waiting = (await asLead((c) => newCase(c))).rows[0]?.id as string;
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE dsar_case SET status = 'closed', outcome = 'fulfilled', responded_on = '2026-10-20' WHERE id = $1",
          [waiting],
        ),
      ),
    ).rejects.toThrow(/dsar_case_identity_first/);
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE dsar_case SET status = 'closed', outcome = 'refused', outcome_reason = 'Identity not confirmed', responded_on = '2026-10-20' WHERE id = $1",
          [waiting],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe("no table the DSAR collector searches is hidden from its organisation-wide read", () => {
  it("names every member-dependent table in the subject map (none today), so none is a silent gap", async () => {
    // A restrictive read policy that checks the member's permission or identity, with no
    // organisation-wide alternative (tenant scope, or no member at all).
    const { rows } = await db.pool("harbour_owner").query<{ table: string; qual: string }>(
      `SELECT tablename AS table, qual FROM pg_policies
        WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE' AND cmd IN ('SELECT', 'ALL')
          AND 'harbour_app' = ANY (roles)`,
    );
    const organisationWide = [
      "current_scope() = 'tenant'",
      "ARRAY['tenant'",
      "current_user_id() IS NULL",
      "handover_whole",
      // Outside the family portal, these read through person_visible, which passes for any person
      // the organisation-wide read can see.
      "person_visible(",
    ];
    const memberDependent = [
      ...new Set(
        rows
          .filter((r) =>
            /holds_role_permission|holds_permission_at|current_user_id\(\)/.test(r.qual),
          )
          .filter((r) => !organisationWide.some((token) => r.qual.includes(token)))
          .map((r) => r.table),
      ),
    ].sort();
    // The rule finds the tables it should (reads that need a permission).
    expect(memberDependent).toEqual(expect.arrayContaining(["dpia", "sub_processor_response"]));
    const map = dsarSubjectMap(EXPORT_TABLES);
    const searched = new Set([...map.person, ...map.contact, ...map.staff].map((e) => e.table));
    expect(memberDependent.filter((t) => searched.has(t))).toEqual(
      Object.keys(DSAR_MEMBER_SCOPED_TABLES).sort(),
    );
  });
});
