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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EICAR } from "../src/integrations/storage";
import { createHarness, type Harness } from "./support/harness";

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
    const audited = await asDemoTenant((c) =>
      c.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action = 'platform.retention_candidate.list'",
      ),
    );
    expect(audited.rows[0].n).toBeGreaterThan(0);

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
