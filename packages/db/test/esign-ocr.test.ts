import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * E-signature requests and OCR extractions in the database (slice 79; ADR-0095; migration 0133):
 * tenant isolation, the person scope on OCR rows and their history, the text as read that never
 * changes, finished extractions and requests that stay finished, and the engine allowlist.
 */

let db: TestDatabase;
const a = ids.a;
const HASH = "c".repeat(64);
let orgDocument: string;
let caraDocument: string;
let adaDocument: string;

const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const app = () => db.pool("harbour_app");
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), fn);

async function extraction(
  c: pg.PoolClient,
  personId: string,
  documentId: string,
  engine = "mock",
  location = "local",
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ocr_extraction (person_id, document_id, engine, location, state, requested_by)
     VALUES ($1, $2, $3, $4, 'ready', $5) RETURNING id`,
    [personId, documentId, engine, location, a.manager],
  );
  return rows[0]?.id as string;
}

async function field(c: pg.PoolClient, extractionId: string, personId: string, position: number) {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO ocr_field (extraction_id, person_id, position, line_group, label, read_text, confidence)
     VALUES ($1, $2, $3, 0, 'dose', '1 tablet', 0.875) RETURNING id`,
    [extractionId, personId, position],
  );
  return rows[0]?.id as string;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  const docs = await asOwner(TENANT_A, (c) =>
    c.query<{ id: string; title: string }>(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes, sha256, person_id)
       VALUES ('organisation_document', 'Lone working policy', 'organisation_document', 'eo1', 'application/pdf', 10, $1, NULL),
              ('person_document', 'Scanned MAR chart', 'care_record', 'eo2', 'image/jpeg', 10, $1, $2),
              ('person_document', 'Scanned MAR chart', 'care_record', 'eo3', 'image/jpeg', 10, $1, $3)
       RETURNING id, storage_key AS title`,
      [HASH, a.personAda, a.personCara],
    ),
  );
  orgDocument = docs.rows.find((d) => d.title === "eo1")?.id as string;
  adaDocument = docs.rows.find((d) => d.title === "eo2")?.id as string;
  caraDocument = docs.rows.find((d) => d.title === "eo3")?.id as string;
});
afterAll(async () => {
  await db?.drop();
});

describe("signature requests (migration 0133)", () => {
  let requestId: string;

  it("are the organisation's own: another tenant sees none and cannot add one", async () => {
    requestId = await asManager(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO signature_request (document_id, document_sha256, signer_tenant_user_id, provider, requested_by)
         VALUES ($1, $2, $3, 'in_app', $4) RETURNING id`,
        [orgDocument, HASH, a.carer, a.manager],
      );
      return rows[0]?.id as string;
    });
    const seen = await asOtherTenant((c) => c.query("SELECT id FROM signature_request"));
    expect(seen.rows).toEqual([]);
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO signature_request (tenant_id, document_id, document_sha256, signer_tenant_user_id, provider, requested_by)
           VALUES ($1, $2, $3, $4, 'in_app', $5)`,
          [TENANT_A, orgDocument, HASH, a.carer, a.manager],
        ),
      ),
    ).rejects.toThrow();
  });

  it("refuses a signed in-app request without its signature and step-up evidence", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE signature_request SET state = 'signed', signed_at = now() WHERE id = $1", [
          requestId,
        ]),
      ),
    ).rejects.toThrow(/signature_request_signed/);
  });

  it("never changes the document, the hash or the signer, and a finished one stays finished", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE signature_request SET signer_tenant_user_id = $2 WHERE id = $1", [
          requestId,
          a.northManager,
        ]),
      ),
    ).rejects.toThrow(/subject cannot change/);
    await asManager((c) =>
      c.query(
        "UPDATE signature_request SET state = 'cancelled', closed_reason = 'Sent in error' WHERE id = $1",
        [requestId],
      ),
    );
    await expect(
      asManager((c) =>
        c.query("UPDATE signature_request SET state = 'requested' WHERE id = $1", [requestId]),
      ),
    ).rejects.toThrow(/finished/);
  });

  it("binds a signature to this tenant's signature on the same document (ADR-0002)", async () => {
    const other = await asOwner(TENANT_B, (c) =>
      c
        .query<{ id: string; doc: string }>(
          `WITH d AS (
             INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes, sha256)
             VALUES ('organisation_document', 'Other policy', 'organisation_document', 'eob', 'application/pdf', 10, $1)
             RETURNING id)
           INSERT INTO document_signature (document_id, signer_name, signer_capacity, statement, document_sha256)
           SELECT id, 'Bo Other', 'staff', 'I have read this document and I agree to it.', $1 FROM d
           RETURNING id, document_id AS doc`,
          [HASH],
        )
        .then((r) => r.rows[0] as { id: string; doc: string }),
    );
    const fresh = await asManager((c) =>
      c
        .query<{ id: string }>(
          `INSERT INTO signature_request (document_id, document_sha256, signer_tenant_user_id, provider, requested_by)
           VALUES ($1, $2, $3, 'in_app', $4) RETURNING id`,
          [orgDocument, HASH, a.carer, a.manager],
        )
        .then((r) => r.rows[0]?.id as string),
    );
    await expect(
      asManager((c) =>
        c.query(
          `UPDATE signature_request SET state = 'signed', signed_at = now(), signature_id = $2,
             step_up_method = 'second_factor' WHERE id = $1`,
          [fresh, other.id],
        ),
      ),
    ).rejects.toThrow(/signature_request_signature_fk/);
  });

  it("refuses an unknown provider and a hash that is not SHA-256", async () => {
    for (const [provider, hash] of [
      ["adobe_sign", HASH],
      ["in_app", "not-a-hash"],
    ]) {
      await expect(
        asManager((c) =>
          c.query(
            `INSERT INTO signature_request (document_id, document_sha256, signer_tenant_user_id, provider, requested_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [orgDocument, hash, a.carer, provider, a.manager],
          ),
        ),
      ).rejects.toThrow();
    }
  });

  it("is never deleted by the application", async () => {
    await expect(
      asManager((c) => c.query("DELETE FROM signature_request WHERE id = $1", [requestId])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("hazard HZ-005 OCR extractions and fields (migration 0133)", () => {
  let ada: string;
  let cara: string;
  let adaField: string;

  beforeAll(async () => {
    ada = await asManager((c) => extraction(c, a.personAda, adaDocument));
    cara = await asManager((c) => extraction(c, a.personCara, caraDocument));
    adaField = await asManager((c) => field(c, ada, a.personAda, 0));
    await asManager((c) => field(c, cara, a.personCara, 0));
  });

  it("follow the person's scope: a North House manager sees Ada's, never Cara's", async () => {
    const extractions = await asNorth((c) =>
      c.query<{ id: string }>("SELECT id FROM ocr_extraction ORDER BY id"),
    );
    expect(extractions.rows.map((r) => r.id)).toEqual([ada]);
    const fields = await asNorth((c) =>
      c.query<{ person_id: string }>("SELECT person_id FROM ocr_field"),
    );
    expect(fields.rows.map((r) => r.person_id)).toEqual([a.personAda]);
    await expect(asNorth((c) => field(c, cara, a.personCara, 1))).rejects.toThrow();
  });

  it("are another tenant's never", async () => {
    const seen = await asOtherTenant((c) =>
      c.query("SELECT id FROM ocr_extraction UNION ALL SELECT id FROM ocr_field"),
    );
    expect(seen.rows).toEqual([]);
  });

  it("refuse an engine or a location off the allowlist (ADR-0098)", async () => {
    for (const [engine, location] of [
      ["google_document_ai", "us"],
      ["aws_textract", "eu-west-2"],
      ["mock", "europe-west2"],
    ]) {
      await expect(
        asManager((c) => extraction(c, a.personAda, adaDocument, engine, location)),
      ).rejects.toThrow(/ocr_extraction_engine/);
    }
    await expect(
      asManager((c) =>
        extraction(c, a.personAda, adaDocument, "google_document_ai", "europe-west2"),
      ),
    ).resolves.toBeTruthy();
  });

  it("keep the text as read: only a person's decision changes a field, once", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE ocr_field SET read_text = '2 tablets' WHERE id = $1", [adaField]),
      ),
    ).rejects.toThrow(/as read cannot change/);
    await expect(
      asManager((c) =>
        c.query("UPDATE ocr_field SET state = 'confirmed' WHERE id = $1", [adaField]),
      ),
    ).rejects.toThrow(/ocr_field_decided/);
    await asManager((c) =>
      c.query(
        `UPDATE ocr_field SET state = 'corrected', value = '2 tablets', decided_line_group = 0,
           decided_label = 'dose', decided_by = $2, decided_at = now()
         WHERE id = $1`,
        [adaField, a.manager],
      ),
    );
    await expect(
      asManager((c) =>
        c.query("UPDATE ocr_field SET value = '3 tablets' WHERE id = $1", [adaField]),
      ),
    ).rejects.toThrow(/decided value cannot change/);
  });

  it("keep earlier versions to the person's scope too", async () => {
    const versions = await asNorth((c) =>
      c.query<{ record_id: string }>(
        "SELECT record_id FROM record_version WHERE table_name = 'ocr_field'",
      ),
    );
    expect(versions.rows.map((r) => r.record_id)).toEqual([adaField]);
    // Cara's field changes; the North House manager still sees no version of it.
    const caraField = await asManager((c) =>
      c
        .query<{ id: string }>("SELECT id FROM ocr_field WHERE person_id = $1", [a.personCara])
        .then((r) => r.rows[0]?.id as string),
    );
    await asManager((c) =>
      c.query(
        `UPDATE ocr_field SET state = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`,
        [caraField, a.manager],
      ),
    );
    const after = await asNorth((c) =>
      c.query("SELECT 1 FROM record_version WHERE record_id = $1", [caraField]),
    );
    expect(after.rows).toEqual([]);
  });

  it("stay finished once released, with who and when", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE ocr_extraction SET state = 'released' WHERE id = $1", [ada]),
      ),
    ).rejects.toThrow(/ocr_extraction_closed/);
    await asManager((c) =>
      c.query(
        `UPDATE ocr_extraction SET state = 'released', released_by = $2, released_at = now(),
           lines_counted = 1, line_statuses = '[{"line": 0, "status": "active"}]', chart_from = '2026-10-05',
           chart_to = '2026-11-01', person_confirmed_by = $2
         WHERE id = $1`,
        [ada, a.manager],
      ),
    );
    await expect(
      asManager((c) => c.query("UPDATE ocr_extraction SET state = 'ready' WHERE id = $1", [ada])),
    ).rejects.toThrow(/finished extraction/);
    await expect(
      asManager((c) => c.query("DELETE FROM ocr_field WHERE extraction_id = $1", [ada])),
    ).rejects.toThrow(/permission denied/);
  });
});
