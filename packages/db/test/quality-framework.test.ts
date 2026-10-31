import { REGULATORS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FRAMEWORK_REGULATOR_CODES, FRAMEWORK_STATE_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The compliance framework and evidence library in the database (quality.md section 18;
 * QUAL-001, QUAL-002; ADR-0096; HZ-011; migration 0076): the seeded framework version 1, global
 * framework tables read-only to the application, published content fixed, tenant mappings
 * append-only and numbered next, evidence links naming real statements of a published version and
 * changing only to be removed, the evidence library open only to holders of quality.evidence.manage,
 * and neither crossing tenants.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const FW = "0192f1a0-0000-7000-8000-000000000001";
const RECORD = "0199f000-0000-7000-8000-0000000000f1";
const asOwnerRole = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);
const asLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const mapping = (c: pg.PoolClient, version: number, entries: unknown[]) =>
  c.query(
    `INSERT INTO framework_mapping (framework_version_id, mapping_version, entries)
     VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [FW, version, JSON.stringify(entries)],
  );
const link = (c: pg.PoolClient, statements: string[], fw = FW) =>
  c.query<{ id: string }>(
    `INSERT INTO evidence_link (record_type, record_id, framework_version_id, statement_ids)
     VALUES ('care_note', $1, $2, $3) RETURNING id`,
    [RECORD, fw, statements],
  );
const entry = {
  statementId: "safe.safeguarding",
  localTitle: null,
  ownerRole: "quality_lead",
  evidenceCategoryIds: ["processes"],
};

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  const lead = "{quality.evidence.manage}";
  for (const [tenant, roleId, user] of [
    [TENANT_A, "0199f000-0000-7000-8000-000000000601", a.manager],
    [TENANT_B, "0199f000-0000-7000-8000-000000000602", b.manager],
  ] as const) {
    await inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), async (c) => {
      await c.query(
        `INSERT INTO role (id, key, name, scope_kind, permissions)
         VALUES ($1, 'quality_lead_${tenant.slice(-2)}', 'Quality lead', 'tenant', $2)`,
        [roleId, lead],
      );
      await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
        user,
        roleId,
      ]);
    });
  }
});

afterAll(async () => {
  await db?.drop();
});

describe("the seeded framework (ADR-0096; migration 0076)", () => {
  it("holds CQC's version 1: 5 key questions, 34 quality statements and 6 evidence categories", async () => {
    const counts = await asLead((c) =>
      c.query<{ kq: string; st: string; ec: string; state: string; url: string }>(
        `SELECT (SELECT count(*) FROM framework_key_question WHERE framework_version_id = $1) AS kq,
                (SELECT count(*) FROM framework_statement WHERE framework_version_id = $1) AS st,
                (SELECT count(*) FROM framework_evidence_category WHERE framework_version_id = $1) AS ec,
                v.state, v.source_url AS url
           FROM framework_version v WHERE v.id = $1`,
        [FW],
      ),
    );
    expect(counts.rows[0]).toMatchObject({ kq: "5", st: "34", ec: "6", state: "published" });
    expect(counts.rows[0]?.url).toMatch(/^https:\/\/www\.cqc\.org\.uk\//);
  });

  it("keeps the key question ids the evidence pack screens already send", async () => {
    const { rows } = await asCarer((c) =>
      c.query<{ id: string }>(
        "SELECT id FROM framework_key_question WHERE framework_version_id = $1 ORDER BY position",
        [FW],
      ),
    );
    expect(rows.map((r) => r.id)).toEqual([
      "safe",
      "effective",
      "caring",
      "responsive",
      "well-led",
    ]);
  });

  it("keeps the database codes in step with the domain", () => {
    expect([...FRAMEWORK_REGULATOR_CODES]).toEqual([...REGULATORS]);
    expect([...FRAMEWORK_STATE_CODES]).toEqual(["draft", "published", "retired"]);
  });
});

describe("hazard HZ-011 framework tables are global, read-only reference data", () => {
  it.each([
    ["UPDATE framework_statement SET title = 'Changed' WHERE id = 'safe.safeguarding'"],
    ["DELETE FROM framework_key_question WHERE id = 'safe'"],
    [
      "INSERT INTO framework_version (id, framework_key, regulator, version_number, state, source_name, source_provision, source_url) VALUES (app.uuid_v7(), 'x', 'cqc', 9, 'draft', 's', 'p', 'https://example.invalid')",
    ],
  ])("refuses the application: %s", async (statement) => {
    await expect(asLead((c) => c.query(statement))).rejects.toThrow(/permission denied/);
  });

  it("never changes a published version's content, even for the owner role", async () => {
    await expect(
      asOwnerRole((c) =>
        c.query("UPDATE framework_statement SET title = 'Changed' WHERE id = 'safe.safeguarding'"),
      ),
    ).rejects.toThrow(/never changes/);
    await expect(
      asOwnerRole((c) =>
        c.query("UPDATE framework_version SET version_number = 2 WHERE id = $1", [FW]),
      ),
    ).rejects.toThrow(/only moves/);
  });
});

describe("hazard HZ-011 tenant mappings (rule 5)", () => {
  it("numbers mapping versions next, names only the version's statements, and stays append-only", async () => {
    await asLead((c) => mapping(c, 1, [entry]));
    await expect(asLead((c) => mapping(c, 1, [entry]))).rejects.toThrow(
      /changed since it was read/,
    );
    await expect(asLead((c) => mapping(c, 3, [entry]))).rejects.toThrow(
      /changed since it was read/,
    );
    await expect(
      asLead((c) => mapping(c, 2, [{ ...entry, statementId: "safe.not_a_statement" }])),
    ).rejects.toThrow(/each statement/);
    await expect(
      asLead((c) => mapping(c, 2, [{ ...entry, evidenceCategoryIds: ["gossip"] }])),
    ).rejects.toThrow(/each statement/);
    await expect(asLead((c) => mapping(c, 2, [entry, entry]))).rejects.toThrow(/each statement/);
    await asLead((c) => mapping(c, 2, []));
    await expect(
      asLead((c) => c.query("UPDATE framework_mapping SET entries = '[]'")),
    ).rejects.toThrow();
    await expect(asLead((c) => c.query("DELETE FROM framework_mapping"))).rejects.toThrow();
  });

  it("keeps each tenant's mappings to itself, numbered on their own", async () => {
    await asOtherTenant((c) => mapping(c, 1, [entry]));
    const seen = await asOtherTenant((c) =>
      c.query<{ v: number }>("SELECT mapping_version AS v FROM framework_mapping ORDER BY v"),
    );
    expect(seen.rows.map((r) => r.v)).toEqual([1]);
  });

  it("shows nothing to someone without quality.evidence.manage, and lets them write nothing", async () => {
    const { rows } = await asCarer((c) => c.query("SELECT id FROM framework_mapping"));
    expect(rows).toEqual([]);
    // The carer sees no mapping, so 1 is "next" for them; row-level security still refuses it.
    await expect(asCarer((c) => mapping(c, 1, [entry]))).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-011 evidence links (rule 6)", () => {
  it("tags real statements of a published version in the tagger's name, and refuses others", async () => {
    const { rows } = await asLead((c) =>
      link(c, ["safe.safeguarding", "well-led.freedom_to_speak_up"]),
    );
    expect(rows[0]?.id).toBeTruthy();
    await expect(asLead((c) => link(c, ["safe.made_up"]))).rejects.toThrow(
      /published framework version/,
    );
    await expect(asLead((c) => link(c, []))).rejects.toThrow(/evidence_link_statements/);
    await expect(
      asLead((c) =>
        c.query(
          `INSERT INTO evidence_link (record_type, record_id, framework_version_id, statement_ids, tagged_by)
           VALUES ('care_note', $1, $2, '{safe.safeguarding}', $3)`,
          [RECORD, FW, a.carer],
        ),
      ),
    ).rejects.toThrow(/tagger's name/);
  });

  it("changes a link only to remove it, once, with a reason, and never deletes it", async () => {
    const { rows } = await asLead((c) => link(c, ["safe.safeguarding"]));
    const id = rows[0]?.id as string;
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE evidence_link SET statement_ids = '{safe.learning_culture}' WHERE id = $1",
          [id],
        ),
      ),
    ).rejects.toThrow(/only changes to be removed/);
    await asLead((c) =>
      c.query(
        "UPDATE evidence_link SET removed_at = now(), removed_by = $2, removal_reason = 'Tagged in error' WHERE id = $1",
        [id, a.manager],
      ),
    );
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE evidence_link SET removed_at = now(), removed_by = $2, removal_reason = 'Again' WHERE id = $1",
          [id, a.manager],
        ),
      ),
    ).rejects.toThrow(/only changes to be removed/);
    await expect(
      asLead((c) => c.query("DELETE FROM evidence_link WHERE id = $1", [id])),
    ).rejects.toThrow();
    const versions = await asOwnerRole((c) =>
      c.query<{ n: string }>("SELECT count(*) AS n FROM record_version WHERE record_id = $1", [id]),
    );
    expect(Number(versions.rows[0]?.n)).toBeGreaterThan(0);
  });

  it("never shows one tenant's links to another, nor to someone without the permission", async () => {
    const other = await asOtherTenant((c) => c.query("SELECT id FROM evidence_link"));
    expect(other.rows).toEqual([]);
    const carer = await asCarer((c) => c.query("SELECT id FROM evidence_link"));
    expect(carer.rows).toEqual([]);
    await expect(asCarer((c) => link(c, ["safe.safeguarding"]))).rejects.toThrow(
      /row-level security/,
    );
  });
});
