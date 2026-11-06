import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Documents about a person follow the person's scope; signatures and destruction certificates are
 * append-only; legal holds and certificates are for tenant-wide roles only (ADR-0002, section 5.1).
 */

let db: TestDatabase;
const a = ids.a;
const HASH = "ab".repeat(32);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes, sha256, person_id)
       VALUES ('person_document', 'Ada letter', 'care_record', 'k1', 'application/pdf', 10, $3, $1),
              ('person_document', 'Ben letter', 'care_record', 'k2', 'application/pdf', 10, $3, $2),
              ('organisation_document', 'Fire policy', 'organisation_document', 'k3', 'application/pdf', 10, $3, NULL)`,
      [a.personAda, a.personBen, HASH],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");

async function titles(context: ReturnType<typeof ctx>): Promise<string[]> {
  return inContext(app(), context, async (c) => {
    const { rows } = await c.query<{ title: string }>("SELECT title FROM document ORDER BY title");
    return rows.map((r) => r.title);
  });
}

describe("hazard HZ-011 document scope", () => {
  it("shows a care worker documents about their assigned people and organisation documents", async () => {
    expect(await titles(ctx(TENANT_A, a.carer, "assigned"))).toEqual(["Ada letter", "Fire policy"]);
  });

  it("shows a tenant-wide role every document and another tenant none of them", async () => {
    expect(await titles(ctx(TENANT_A, a.manager, "tenant"))).toEqual([
      "Ada letter",
      "Ben letter",
      "Fire policy",
    ]);
    expect(await titles(ctx(TENANT_B, ids.b.manager, "tenant"))).toEqual([]);
  });

  it("refuses a document that points at another tenant's person", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) =>
        c.query(
          `INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes, sha256, person_id)
           VALUES ('person_document', 'Cross', 'care_record', 'k9', 'application/pdf', 10, $2, $1)`,
          [ids.b.personDev, HASH],
        ),
      ),
    ).rejects.toThrow(/row-level security|document_person_fk/);
  });
});

describe("signatures, holds and certificates", () => {
  it("keeps signatures append-only", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO document_signature (document_id, person_id, signer_name, signer_capacity, statement, document_sha256)
           SELECT id, person_id, 'Ada Example', 'person', 'I agree to this document.', sha256 FROM document WHERE title = 'Ada letter'
           RETURNING id`,
        );
        await c.query("UPDATE document_signature SET signer_name = 'Someone Else' WHERE id = $1", [
          rows[0]?.id,
        ]);
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets only tenant-wide roles see or place legal holds", async () => {
    await inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) =>
      c.query("INSERT INTO legal_hold (person_id, reason) VALUES ($1, 'Coroner inquest')", [
        a.personAda,
      ]),
    );
    const seen = await inContext(
      app(),
      ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]),
      async (c) => {
        const { rows } = await c.query("SELECT id FROM legal_hold");
        return rows.length;
      },
    );
    expect(seen).toBe(0);
    await expect(
      inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), (c) =>
        c.query("INSERT INTO legal_hold (person_id, reason) VALUES ($1, 'Claim')", [a.personBen]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a legal hold with no target", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) =>
        c.query("INSERT INTO legal_hold (reason) VALUES ('Nothing held')"),
      ),
    ).rejects.toThrow(/legal_hold_target/);
  });

  it("keeps destruction certificates append-only", async () => {
    const insert = `INSERT INTO destruction_certificate (record_class, subject_type, subject_ids, record_count, retention_rule, reason, method)
           VALUES ('care_record', 'document', ARRAY[app.uuid_v7()], 1, '{"period":8,"unit":"years"}', 'Past retention', 'storage_delete')`;
    // Only holders of platform.retention.manage issue certificates (migration 0117).
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) => c.query(insert)),
    ).rejects.toThrow(/row-level security/);
    await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(insert),
    );
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) =>
        c.query("DELETE FROM destruction_certificate"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
