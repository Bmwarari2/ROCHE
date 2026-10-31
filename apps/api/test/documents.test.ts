import { createHash } from "node:crypto";
import type {
  DestructionCertificateList,
  DestructionResult,
  DocumentItem,
  DocumentList,
  LegalHoldItem,
  ProblemDetails,
  RetentionCandidateList,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EICAR } from "../src/integrations/storage";
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness } from "./support/harness";

let h: Harness;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown; raw?: { bytes: Uint8Array; contentType: string } } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

function upload(
  user: keyof Harness["tokens"],
  query: Record<string, string>,
  bytes: Uint8Array,
  contentType: string,
) {
  return as(user, `/v1/documents?${new URLSearchParams(query)}`, {
    method: "POST",
    raw: { bytes, contentType },
  });
}

async function asDemoTenant<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

/** Care ended nine years ago: past the 8-year care-record period. */
const dischargedLongAgo = (personId: string) =>
  asDemoTenant((c) =>
    c.query(
      "UPDATE person SET status = 'discharged', discharged_at = now() - interval '9 years' WHERE id = $1",
      [personId],
    ),
  );

const storageKeyOf = async (documentId: string) =>
  (
    await asDemoTenant((c) =>
      c.query<{ storage_key: string }>("SELECT storage_key FROM document WHERE id = $1", [
        documentId,
      ]),
    )
  ).rows[0]?.storage_key ?? "";

/** The outbox events that delete a destroyed document's bytes. */
const destroyedEvents = async (documentId: string) =>
  (
    await asDemoTenant((c) =>
      c.query<{ published: boolean; attempts: number }>(
        `SELECT published_at IS NOT NULL AS published, attempts FROM outbox_event
         WHERE event_type = 'platform.document.destroyed' AND aggregate_id = $1`,
        [documentId],
      ),
    )
  ).rows;

/** Waits until a request is blocked on an advisory lock (the retention lock). */
async function waitForRetentionLockWaiter(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await h.db.pool("harbour_owner").query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No request waited for the retention lock");
}

/**
 * Holds the organisation's retention lock in a transaction, as the routes take it, runs `before`
 * in it, then sends `send`'s request; commits once that request is waiting for the lock, and
 * returns its response.
 */
async function whileRetentionLockHeld(
  before: (client: pg.PoolClient) => Promise<unknown>,
  send: () => Promise<Response>,
): Promise<Response> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `retention:${DEMO.tenantId}`,
    ]);
    await before(client);
    const pending = send();
    await waitForRetentionLockWaiter();
    await client.query("COMMIT");
    return await pending;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("person photos (hazard HZ-001)", () => {
  it("stores a photo and serves it with headers that stop it being run as anything else", async () => {
    const put = await as("manager", `/v1/people/${resident(1)}/photo`, {
      method: "PUT",
      raw: { bytes: JPEG, contentType: "image/jpeg" },
    });
    expect(put.status).toBe(201);
    expect(await json<DocumentItem>(put)).toMatchObject({
      category: "person_photo",
      status: "available",
      scanStatus: "clean",
      contentType: "image/jpeg",
      sha256: sha(JPEG),
    });

    const photo = await as("carer", `/v1/people/${resident(1)}/photo`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(photo.headers.get("content-security-policy")).toContain("sandbox");
    expect(photo.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG);

    const people = await json<{ items: { id: string; photoUrl: string | null }[] }>(
      await as("carer", "/v1/people"),
    );
    expect(people.items.find((p) => p.id === resident(1))?.photoUrl).toBe(
      `/v1/people/${resident(1)}/photo`,
    );
  });

  it("refuses a care worker setting a photo", async () => {
    const response = await as("carer", `/v1/people/${resident(1)}/photo`, {
      method: "PUT",
      raw: { bytes: JPEG, contentType: "image/jpeg" },
    });
    expect(response.status).toBe(403);
  });
});

describe("upload checks (ASVS V5)", () => {
  it("refuses HTML dressed as a JPEG", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const response = await upload(
      "manager",
      { category: "person_document", title: "Letter", personId: resident(2) },
      html,
      "image/jpeg",
    );
    expect(response.status).toBe(422);
  });

  it("refuses a file that fails the malware scan and stores nothing", async () => {
    const infected = new Uint8Array([...PDF, ...new TextEncoder().encode(EICAR)]);
    const response = await upload(
      "manager",
      { category: "person_document", title: "Infected", personId: resident(2) },
      infected,
      "application/pdf",
    );
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toBe(
      "The file failed a malware check and was not saved.",
    );
    const list = await json<DocumentList>(
      await as("manager", `/v1/documents?personId=${resident(2)}`),
    );
    expect(list.items.map((d) => d.title)).not.toContain("Infected");
  });

  it("refuses a photo over its category limit and a body over the API limit", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(JPEG);
    const tooBig = await as("manager", `/v1/people/${resident(2)}/photo`, {
      method: "PUT",
      raw: { bytes: big, contentType: "image/jpeg" },
    });
    expect(tooBig.status).toBe(422);
    const huge = new Uint8Array(27 * 1024 * 1024);
    huge.set(PDF);
    const refused = await upload(
      "manager",
      { category: "person_document", title: "Huge", personId: resident(2) },
      huge,
      "application/pdf",
    );
    expect(refused.status).toBe(413);
  });

  it("keeps organisation documents apart from people", async () => {
    const ok = await upload(
      "manager",
      { category: "organisation_document", title: "Fire safety policy" },
      PDF,
      "application/pdf",
    );
    expect(ok.status).toBe(201);
    const withPerson = await upload(
      "manager",
      { category: "organisation_document", title: "Wrong", personId: resident(1) },
      PDF,
      "application/pdf",
    );
    expect(withPerson.status).toBe(422);
  });
});

describe("hazard HZ-011 document scope", () => {
  it("lets a care worker attach to an assigned person but not anyone else", async () => {
    const mine = await upload(
      "carer",
      { category: "care_attachment", title: "Heel photo", personId: resident(1) },
      JPEG,
      "image/jpeg",
    );
    expect(mine.status).toBe(201);
    const other = await upload(
      "carer",
      { category: "care_attachment", title: "Heel photo", personId: resident(5) },
      JPEG,
      "image/jpeg",
    );
    expect(other.status).toBe(404);
  });

  it("hides another person's documents from a care worker", async () => {
    const created = await json<DocumentItem>(
      await upload(
        "manager",
        { category: "person_document", title: "Hospital letter", personId: resident(5) },
        PDF,
        "application/pdf",
      ),
    );
    expect((await as("carer", `/v1/documents/${created.id}`)).status).toBe(404);
    expect((await as("carer", `/v1/documents/${created.id}/content`)).status).toBe(404);
  });

  it("needs MFA for documents about people", async () => {
    const response = await as("nurse", `/v1/documents?personId=${resident(1)}`);
    expect(response.status).toBe(403);
  });
});

describe("versions and signatures", () => {
  it("keeps the previous version and binds signatures to the bytes signed", async () => {
    const v1 = await json<DocumentItem>(
      await upload(
        "manager",
        { category: "person_document", title: "Care agreement", personId: resident(3) },
        PDF,
        "application/pdf",
      ),
    );
    const changed = new TextEncoder().encode("%PDF-1.7\n% version two\n%%EOF\n");
    const v2Response = await as("manager", `/v1/documents/${v1.id}/versions`, {
      method: "POST",
      raw: { bytes: changed, contentType: "application/pdf" },
    });
    expect(v2Response.status).toBe(201);
    const v2 = await json<DocumentItem>(v2Response);
    expect(v2).toMatchObject({
      documentVersion: 2,
      previousVersionId: v1.id,
      sha256: sha(changed),
    });

    const stale = await as("manager", `/v1/documents/${v2.id}/signatures`, {
      method: "POST",
      body: { typedName: "Mo Manager", sha256Seen: v1.sha256 },
    });
    expect(stale.status).toBe(422);

    const signed = await as("manager", `/v1/documents/${v2.id}/signatures`, {
      method: "POST",
      body: { typedName: "Mo Manager", sha256Seen: v2.sha256 },
    });
    expect(signed.status).toBe(201);
    expect((await json<DocumentItem>(signed)).signatures).toMatchObject([
      { signerName: "Mo Manager", signerCapacity: "staff", documentSha256: v2.sha256 },
    ]);

    const download = await as("manager", `/v1/documents/${v2.id}/content`);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(changed);
  });
});

describe("legal holds and destruction (section 5.1)", () => {
  it("never offers held or current records, and certifies what it destroys", async () => {
    // Resident 6 left care nine years ago: past the 8-year care-record period.
    await asDemoTenant((c) =>
      c.query(
        "UPDATE person SET status = 'discharged', discharged_at = now() - interval '9 years' WHERE id = $1",
        [resident(6)],
      ),
    );
    const doc = await json<DocumentItem>(
      await upload(
        "manager",
        { category: "person_document", title: "Old letter", personId: resident(6) },
        PDF,
        "application/pdf",
      ),
    );
    const current = await json<DocumentItem>(
      await upload(
        "manager",
        { category: "person_document", title: "Current letter", personId: resident(4) },
        PDF,
        "application/pdf",
      ),
    );

    const candidates = async () =>
      (await json<RetentionCandidateList>(await as("owner", "/v1/retention/candidates"))).items.map(
        (i) => i.documentId,
      );
    expect(await candidates()).toContain(doc.id);
    expect(await candidates()).not.toContain(current.id);
    // The reviewer sees what is to go: its title and when it was stored.
    const listed = (
      await json<RetentionCandidateList>(await as("owner", "/v1/retention/candidates"))
    ).items.find((i) => i.documentId === doc.id);
    expect(listed).toMatchObject({ title: "Old letter", createdAt: doc.createdAt });
    // The listed ids are in the audit, so who saw which document is known.
    const audited = await asDemoTenant((c) =>
      c.query(
        "SELECT scope FROM audit_event WHERE action = 'platform.retention_candidate.list' ORDER BY seq DESC LIMIT 1",
      ),
    );
    expect(audited.rows[0]?.scope?.documentIds).toContain(doc.id);

    // Someone holding only platform.retention.manage sees the category, never the title of a
    // document about a person whose record they may not read.
    await asDemoTenant(async (c) => {
      const role = await c.query<{ id: string }>(
        `INSERT INTO role (key, name, scope_kind, permissions)
         VALUES ('records_only', 'Records only', 'tenant', '{platform.retention.manage}') RETURNING id`,
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id)
         SELECT id, $1 FROM tenant_user WHERE email = 'agency@example.invalid' AND tenant_id = $2`,
        [role.rows[0]?.id, DEMO.tenantId],
      );
    });
    const recordsOnly = (
      await json<RetentionCandidateList>(await as("agency", "/v1/retention/candidates"))
    ).items.find((i) => i.documentId === doc.id);
    expect(recordsOnly).toBeDefined();
    expect(recordsOnly?.title).toBeUndefined();
    expect(recordsOnly?.category).toBe("person_document");

    const hold = await json<LegalHoldItem>(
      await as("owner", "/v1/legal-holds", {
        method: "POST",
        body: { personId: resident(6), reason: "Coroner has asked for the records" },
      }),
    );
    expect(await candidates()).not.toContain(doc.id);
    const held = await json<DestructionResult>(
      await as("owner", "/v1/retention/destroy", {
        method: "POST",
        body: { documentIds: [doc.id], reason: "Annual records review" },
      }),
    );
    expect(held).toEqual({ certificates: [], skipped: [doc.id] });

    const released = await as("owner", `/v1/legal-holds/${hold.id}/release`, {
      method: "POST",
      body: { reason: "Inquest concluded, hold lifted", version: hold.version },
    });
    expect(released.status).toBe(200);

    const destroyed = await json<DestructionResult>(
      await as("owner", "/v1/retention/destroy", {
        method: "POST",
        body: { documentIds: [doc.id, current.id], reason: "Annual records review" },
      }),
    );
    expect(destroyed.skipped).toEqual([current.id]);
    expect(destroyed.certificates).toMatchObject([
      { recordClass: "care_record", subjectType: "document", recordCount: 1 },
    ]);
    // The certificate stays listed for the data protection lead, newest first.
    const certificates = await json<DestructionCertificateList>(
      await as("owner", "/v1/destruction-certificates"),
    );
    expect(certificates.items[0]).toEqual(destroyed.certificates[0]);
    expect((await as("manager", `/v1/documents/${doc.id}/content`)).status).toBe(404);
    expect((await json<DocumentItem>(await as("manager", `/v1/documents/${doc.id}`))).status).toBe(
      "destroyed",
    );
    // The bytes went once the certificate was committed, and the retry was queued all the same.
    expect(await h.handle.services.storage.get(await storageKeyOf(doc.id))).toBeNull();
    expect(await destroyedEvents(doc.id)).toEqual([{ published: false, attempts: 0 }]);
  });

  it("audits who read the legal holds and the candidates for destruction", async () => {
    const holds = await as("owner", "/v1/legal-holds");
    expect(holds.status).toBe(200);
    const count = (await json<{ items: unknown[] }>(holds)).items.length;
    expect(count).toBeGreaterThan(0);
    const candidates = await as("owner", "/v1/retention/candidates");
    expect(candidates.status).toBe(200);
    // Each response names the id the API wrote to its audit rows.
    const ids = [holds, candidates].map((r) => r.headers.get("x-request-id"));
    const audited = await asDemoTenant((c) =>
      c.query<{ action: string; actor: string; scope: { count: number } }>(
        `SELECT action, actor_tenant_user_id AS actor, scope FROM audit_event
         WHERE request_id = ANY($1::text[]) ORDER BY seq`,
        [ids],
      ),
    );
    expect(audited.rows).toEqual([
      { action: "platform.legal_hold.list", actor: DEMO.users.owner.id, scope: { count } },
      {
        action: "platform.retention_candidate.list",
        actor: DEMO.users.owner.id,
        scope: expect.objectContaining({ count: expect.any(Number) }),
      },
    ]);
  });

  it("sees a hold committed while the destruction waits, and a hold waits for a destruction", async () => {
    await dischargedLongAgo(resident(5));
    const doc = await json<DocumentItem>(
      await upload(
        "manager",
        { category: "person_document", title: "Old care plan", personId: resident(5) },
        PDF,
        "application/pdf",
      ),
    );

    // A hold being placed (the route's lock, then the row), committed only once the destruction
    // is waiting for the lock.
    const destroyed = await whileRetentionLockHeld(
      (placing) =>
        placing.query("INSERT INTO legal_hold (person_id, reason) VALUES ($1, $2)", [
          resident(5),
          "Solicitor's letter received",
        ]),
      () =>
        as("owner", "/v1/retention/destroy", {
          method: "POST",
          body: { documentIds: [doc.id], reason: "Annual records review" },
        }),
    );
    // Under READ COMMITTED the holds are read after the lock, so it is seen: nothing destroyed.
    expect(await json<DestructionResult>(destroyed)).toEqual({
      certificates: [],
      skipped: [doc.id],
    });
    expect(await h.handle.services.storage.get(await storageKeyOf(doc.id))).not.toBeNull();

    // A destruction in progress (the same lock): placing a hold waits for it to commit.
    const hold = await whileRetentionLockHeld(
      async () => undefined,
      () =>
        as("owner", "/v1/legal-holds", {
          method: "POST",
          body: { personId: resident(5), reason: "Second request from the solicitor" },
        }),
    );
    expect(hold.status).toBe(201);
  });

  it("keeps the certificate when the bytes cannot be deleted, and retries until they are", async () => {
    await dischargedLongAgo(resident(2));
    const doc = await json<DocumentItem>(
      await upload(
        "manager",
        { category: "person_document", title: "Old letter", personId: resident(2) },
        PDF,
        "application/pdf",
      ),
    );
    const key = await storageKeyOf(doc.id);
    const { storage } = h.handle.services;
    const failing = vi.spyOn(storage, "destroy").mockRejectedValue(new Error("unreachable"));

    const result = await json<DestructionResult>(
      await as("owner", "/v1/retention/destroy", {
        method: "POST",
        body: { documentIds: [doc.id], reason: "Annual records review" },
      }),
    );
    // Committed before the bytes were touched: the tombstone and the certificate stand.
    expect(result.skipped).toEqual([]);
    expect(result.certificates).toMatchObject([{ recordClass: "care_record", recordCount: 1 }]);
    const certificate = await asDemoTenant((c) =>
      c.query<{ subject_ids: string[] }>(
        "SELECT subject_ids FROM destruction_certificate WHERE id = $1",
        [result.certificates[0]?.id],
      ),
    );
    expect(certificate.rows[0]?.subject_ids).toEqual([doc.id]);
    expect((await json<DocumentItem>(await as("manager", `/v1/documents/${doc.id}`))).status).toBe(
      "destroyed",
    );
    expect(await storage.get(key)).not.toBeNull();
    expect(await destroyedEvents(doc.id)).toEqual([{ published: false, attempts: 0 }]);

    // The worker tries again: still failing, it is logged for the operator's alarm and kept.
    const logger = createLogger("silent");
    const logged = vi.spyOn(logger, "error");
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: h.handle.services.db,
      logger,
      storage,
    };
    await relayOutbox(deps, outboxHandlers(deps));
    expect(await destroyedEvents(doc.id)).toEqual([{ published: false, attempts: 1 }]);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "worker.job.failed",
        queue: "document-destruction",
        tenantId: DEMO.tenantId,
      }),
      "worker.job.failed",
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("Old letter");

    // The worker makes the key from the ids (review of #134, L6): a storage_key changed in the
    // row meanwhile, here to another live document's, never points the deletion elsewhere.
    const decoy = await json<DocumentItem>(
      await upload(
        "manager",
        { category: "person_document", title: "Current letter", personId: resident(4) },
        PDF,
        "application/pdf",
      ),
    );
    const decoyKey = await storageKeyOf(decoy.id);
    await asDemoTenant((c) =>
      c.query("UPDATE document SET storage_key = $2 WHERE id = $1", [doc.id, decoyKey]),
    );

    // Storage is back: the next try deletes every version and the event is done.
    failing.mockRestore();
    await asDemoTenant((c) =>
      c.query(
        "UPDATE outbox_event SET available_at = now() WHERE aggregate_id = $1 AND event_type = 'platform.document.destroyed'",
        [doc.id],
      ),
    );
    await relayOutbox(deps, outboxHandlers(deps));
    expect(await destroyedEvents(doc.id)).toEqual([{ published: true, attempts: 2 }]);
    expect(await storage.get(key)).toBeNull();
    expect(await storage.get(decoyKey)).not.toBeNull();
  });

  it("refuses both retention lists without a fresh step-up", async () => {
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      for (const path of ["/v1/retention/candidates", "/v1/destruction-certificates"]) {
        const refused = await as("owner", path);
        expect(refused.status, path).toBe(403);
        expect(((await refused.json()) as { code: string }).code).toBe("step_up_required");
      }
    } finally {
      await ageSession(auth, session, 0);
    }
  });

  describe("what a hold covers (security review, 31 October 2026)", () => {
    /** A document about resident 3, whose care ended nine years ago. */
    const store = async (title: string, subject: Record<string, string> = {}) =>
      json<DocumentItem>(
        await upload(
          "manager",
          { category: "person_document", title, personId: resident(3), ...subject },
          PDF,
          "application/pdf",
        ),
      );
    const newVersion = async (of: DocumentItem) =>
      json<DocumentItem>(
        await as("manager", `/v1/documents/${of.id}/versions`, {
          method: "POST",
          raw: { bytes: PDF, contentType: "application/pdf" },
        }),
      );
    const hold = async (subjectType: string, subjectId: string) => {
      const placed = await as("owner", "/v1/legal-holds", {
        method: "POST",
        body: { subjectType, subjectId, reason: "Claim notified by the insurer" },
      });
      expect(placed.status).toBe(201);
    };
    const destroy = async (documentIds: string[]) =>
      json<DestructionResult>(
        await as("owner", "/v1/retention/destroy", {
          method: "POST",
          body: { documentIds, reason: "Annual records review" },
        }),
      );
    const candidates = async () =>
      (await json<RetentionCandidateList>(await as("owner", "/v1/retention/candidates"))).items.map(
        (i) => i.documentId,
      );

    beforeAll(async () => {
      await dischargedLongAgo(resident(3));
    });

    it("holds a document through a hold on the record it belongs to", async () => {
      const incidentId = crypto.randomUUID();
      const statement = await store("Statement about the fall", {
        subjectType: "incident",
        subjectId: incidentId,
      });
      const unrelated = await store("Statement about another fall", {
        subjectType: "incident",
        subjectId: crypto.randomUUID(),
      });
      expect(await candidates()).toContain(statement.id);
      await hold("incident", incidentId);
      expect(await candidates()).not.toContain(statement.id);
      const result = await destroy([statement.id, unrelated.id]);
      expect(result.skipped).toEqual([statement.id]);
      expect(result.certificates).toMatchObject([{ recordCount: 1 }]);
    });

    it("holds every version when any one version is held", async () => {
      const first = await store("Tenancy agreement");
      const second = await newVersion(first);
      expect(second.previousVersionId).toBe(first.id);
      await hold("document", first.id);
      expect(await candidates()).not.toContain(second.id);
      expect((await destroy([second.id])).skipped).toEqual([second.id]);

      const older = await store("Room agreement");
      const later = await newVersion(older);
      const latest = await newVersion(later);
      await hold("document", latest.id);
      expect((await destroy([older.id, later.id])).skipped).toEqual([older.id, later.id]);
    });

    it("honours a document's own legal hold flag", async () => {
      const flagged = await store("Consent form");
      await asDemoTenant((c) =>
        c.query("UPDATE document SET legal_hold = true WHERE id = $1", [flagged.id]),
      );
      expect(await candidates()).not.toContain(flagged.id);
      expect((await destroy([flagged.id])).skipped).toEqual([flagged.id]);
      expect(await h.handle.services.storage.get(await storageKeyOf(flagged.id))).not.toBeNull();
    });
  });

  it("keeps holds and destruction to tenant-wide records roles", async () => {
    expect((await as("carer", "/v1/legal-holds")).status).toBe(403);
    // The Registered Manager is location-scoped and cannot destroy records either.
    expect((await as("manager", "/v1/legal-holds")).status).toBe(403);
    expect((await as("manager", "/v1/destruction-certificates")).status).toBe(403);
    expect((await as("carer", "/v1/retention/candidates")).status).toBe(403);
    expect(
      (
        await as("carer", "/v1/retention/destroy", {
          method: "POST",
          body: { documentIds: [resident(1)], reason: "Not allowed to do this" },
        })
      ).status,
    ).toBe(403);
  });
});
