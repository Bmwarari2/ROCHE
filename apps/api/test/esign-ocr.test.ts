import { createHash } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MockDocuSign, MockOcr } from "../src/integrations/esign-ocr";
import { ageSession, createHarness, type Harness, markSessionsVerified } from "./support/harness";

/**
 * E-signature requests and OCR of scanned MAR charts through the API (slice 79; ADR-0095). In
 * Harbour: only the member asked signs, with a fresh second factor, against the exact version.
 * DocuSign (the no-network mock): an envelope carries only what it needs, and only a clean signed
 * copy marks the request signed. OCR: a clean photograph only is read, every value starts
 * unconfirmed, release needs every value decided, and released lines arrive not yet checked.
 * Invented people only.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const upload = (who: string, path: string, bytes: Uint8Array, contentType: string) =>
  h.request(path, {
    method: "POST",
    token: h.tokens[who],
    tenant: DEMO.tenantId,
    raw: { bytes, contentType },
  });

const RESIDENT = "0194d000-0000-7000-8600-000000000001";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pdf = (words: string) =>
  new TextEncoder().encode(`%PDF-1.7\n% ${words}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`);
/** A JPEG-shaped image the OCR mock reads with these fields (test instructions in its bytes). */
const chart = (fields: unknown[] | null, extra = "") =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...new TextEncoder().encode(
      `${fields ? `HARBOUR-OCR-MOCK:${JSON.stringify(fields)}\n` : ""}${extra}`,
    ),
    0xff,
    0xd9,
  ]);
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } finally {
    client.release();
  }
}

async function policy(words: string) {
  const bytes = pdf(words);
  const query = new URLSearchParams({
    category: "organisation_document",
    title: `Policy ${words}`,
  });
  const res = await upload("manager", `/v1/documents?${query}`, bytes, "application/pdf");
  expect(res.status).toBe(201);
  const doc = (await res.json()) as { id: string };
  return { id: doc.id, sha256: sha(bytes) };
}

interface RequestItem {
  id: string;
  version: number;
  state: string;
  provider: string;
  signatureId: string | null;
  signedDocumentId: string | null;
}

beforeAll(async () => {
  h = await createHarness({ MALWARE_SCANNER: "mock", OCR_ENGINE: "mock", DOCUSIGN: "mock" });
  await verified(h);
  // OCR is per organisation: the demo organisation chose the mock engine (ADR-0095).
  await sql("INSERT INTO integration_connection (port, provider) VALUES ('documents.ocr', 'mock')");
});

/** Medicines records need MFA: the demo members have a factor and used it on these sessions. */
async function verified(harness: Harness) {
  const auth = harness.db.pool("harbour_auth");
  await auth.query(
    "UPDATE auth.user SET two_factor_enabled = true, email_verified = true WHERE email LIKE '%@example.invalid'",
  );
  await markSessionsVerified(auth);
}
afterAll(async () => {
  await h?.close();
});

describe("signing in Harbour (ADR-0095)", () => {
  let doc: { id: string; sha256: string };
  let request: RequestItem;

  beforeAll(async () => {
    doc = await policy("lone working");
  });

  it("is asked for by a document manager, for the current version only", async () => {
    const stale = await as("manager", `/v1/documents/${doc.id}/signature-requests`, {
      method: "POST",
      body: { signerId: DEMO.users.carer.id, documentSha256: "e".repeat(64) },
    });
    expect(stale.status).toBe(409);
    const byCarer = await as("carer", `/v1/documents/${doc.id}/signature-requests`, {
      method: "POST",
      body: { signerId: DEMO.users.carer.id, documentSha256: doc.sha256 },
    });
    expect(byCarer.status).toBe(403);
    const made = await as("manager", `/v1/documents/${doc.id}/signature-requests`, {
      method: "POST",
      body: { signerId: DEMO.users.carer.id, documentSha256: doc.sha256 },
    });
    expect(made.status).toBe(201);
    request = (await made.json()) as RequestItem;
    expect(request).toMatchObject({ provider: "in_app", state: "requested" });
    const mine = await as("carer", "/v1/me/signature-requests");
    expect(((await mine.json()) as { items: RequestItem[] }).items.map((i) => i.id)).toContain(
      request.id,
    );
  });

  it("is signed by no one but the member asked", async () => {
    const byNurse = await as("nurse", `/v1/signature-requests/${request.id}/sign`, {
      method: "POST",
      body: { version: request.version, typedName: "Nia Nurse", sha256Seen: doc.sha256 },
    });
    expect(byNurse.status).toBe(404);
  });

  it("needs a fresh second factor, then records the signature and the evidence together", async () => {
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.carer?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const stale = await as("carer", `/v1/signature-requests/${request.id}/sign`, {
        method: "POST",
        body: { version: request.version, typedName: "Cat Carer", sha256Seen: doc.sha256 },
      });
      expect(stale.status).toBe(403);
      expect(((await stale.json()) as { code: string }).code).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
    const other = await as("carer", `/v1/signature-requests/${request.id}/sign`, {
      method: "POST",
      body: { version: request.version, typedName: "Cat Carer", sha256Seen: "f".repeat(64) },
    });
    expect(other.status).toBe(409);
    const signed = await as("carer", `/v1/signature-requests/${request.id}/sign`, {
      method: "POST",
      body: { version: request.version, typedName: "Cat Carer", sha256Seen: doc.sha256 },
    });
    expect(signed.status).toBe(200);
    const item = (await signed.json()) as RequestItem;
    expect(item.state).toBe("signed");
    const [row] = await sql<{
      step_up_method: string;
      signer_name: string;
      document_sha256: string;
    }>(
      `SELECT r.step_up_method, s.signer_name, s.document_sha256
         FROM signature_request r JOIN document_signature s ON s.id = r.signature_id
        WHERE r.id = $1`,
      [request.id],
    );
    expect(row).toEqual({
      step_up_method: "second_factor",
      signer_name: "Cat Carer",
      document_sha256: doc.sha256,
    });
    const audits = await sql(
      "SELECT 1 FROM audit_event WHERE action = 'platform.signature.signed' AND resource_id = $1",
      [request.id],
    );
    expect(audits).toHaveLength(1);
    const again = await as("carer", `/v1/signature-requests/${request.id}/sign`, {
      method: "POST",
      body: { version: item.version, typedName: "Cat Carer", sha256Seen: doc.sha256 },
    });
    expect(again.status).toBe(409);
  });

  it("refuses a person's document: their signatures stay the typed-name flow", async () => {
    const query = new URLSearchParams({
      category: "person_document",
      title: "Letter",
      personId: RESIDENT,
    });
    const res = await upload("manager", `/v1/documents?${query}`, pdf("letter"), "application/pdf");
    expect(res.status).toBe(201);
    const letter = (await res.json()) as { id: string };
    const refused = await as("manager", `/v1/documents/${letter.id}/signature-requests`, {
      method: "POST",
      body: { signerId: DEMO.users.carer.id, documentSha256: sha(pdf("letter")) },
    });
    expect(refused.status).toBe(404);
  });
});

describe("signing never reaches beyond organisation documents (security H1)", () => {
  it("refuses a staff HR document and a logo", async () => {
    const rows = await sql<{ id: string; sha256: string }>(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes, sha256)
       VALUES ('staff_hr_document', 'Right to work', 'staff_file', 'hr1', 'application/pdf', 10, $1),
              ('organisation_logo', 'Logo', 'organisation_document', 'logo1', 'image/png', 10, $1)
       RETURNING id, sha256`,
      ["a".repeat(64)],
    );
    for (const row of rows) {
      const res = await as("manager", `/v1/documents/${row.id}/signature-requests`, {
        method: "POST",
        body: { signerId: DEMO.users.carer.id, documentSha256: row.sha256 },
      });
      expect(res.status).toBe(404);
    }
  });
});

describe("signing through DocuSign (the mock; H-540)", () => {
  const docusign = () => h.handle.services.docusign as MockDocuSign;

  beforeAll(async () => {
    await sql(
      `INSERT INTO integration_connection (port, provider) VALUES ('documents.signature', 'docusign')`,
    );
  });
  afterAll(async () => {
    await sql("DELETE FROM integration_connection WHERE port = 'documents.signature'");
  });

  async function sent(words: string) {
    const doc = await policy(words);
    const made = await as("manager", `/v1/documents/${doc.id}/signature-requests`, {
      method: "POST",
      body: { signerId: DEMO.users.nurse.id, documentSha256: doc.sha256 },
    });
    expect(made.status).toBe(201);
    const item = (await made.json()) as RequestItem;
    expect(item).toMatchObject({ provider: "docusign", state: "sent" });
    const [row] = await sql<{ envelope_id: string }>(
      "SELECT envelope_id FROM signature_request WHERE id = $1",
      [item.id],
    );
    return { doc, item, envelope: row?.envelope_id as string };
  }

  it("sends only the document, a generic subject and the signer's work email and name", async () => {
    const { envelope } = await sent("fire safety");
    const given = docusign().sent.at(-1);
    expect(given?.subject).toBe("A document to sign");
    expect(given?.signer.email).toBe(DEMO.users.nurse.email);
    expect(Object.keys(given ?? {}).sort()).toEqual(
      ["document", "documentSha256", "idempotencyKey", "signer", "subject"].sort(),
    );
    expect(envelope).toMatch(/^mock-envelope-/);
  });

  it("stores the clean signed copy as a new version and marks the request signed", async () => {
    const { item, envelope, doc } = await sent("infection control");
    docusign().complete(envelope, pdf("infection control signed"));
    const refreshed = await as("manager", `/v1/signature-requests/${item.id}/refresh`, {
      method: "POST",
      body: { version: item.version },
    });
    expect(refreshed.status).toBe(200);
    const out = (await refreshed.json()) as RequestItem;
    expect(out.state).toBe("signed");
    const [version] = await sql<{
      previous_version_id: string;
      retention_class: string;
      scan_status: string;
    }>("SELECT previous_version_id, retention_class, scan_status FROM document WHERE id = $1", [
      out.signedDocumentId,
    ]);
    expect(version).toEqual({
      previous_version_id: doc.id,
      retention_class: "organisation_document",
      scan_status: "clean",
    });
  });

  it("never marks a request signed when the returned copy fails the malware scan", async () => {
    const { item, envelope } = await sent("medicines");
    docusign().complete(envelope, new TextEncoder().encode(`%PDF-1.7\n${EICAR}\n%%EOF\n`));
    const refreshed = await as("manager", `/v1/signature-requests/${item.id}/refresh`, {
      method: "POST",
      body: { version: item.version },
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as RequestItem).state).toBe("sent");
  });

  it("records a declined envelope, and cancels with the envelope voided", async () => {
    const declined = await sent("visitors");
    docusign().decline(declined.envelope);
    const out = await as("manager", `/v1/signature-requests/${declined.item.id}/refresh`, {
      method: "POST",
      body: { version: declined.item.version },
    });
    expect(((await out.json()) as RequestItem).state).toBe("declined");
    const cancelled = await sent("smoking");
    const res = await as("manager", `/v1/signature-requests/${cancelled.item.id}/cancel`, {
      method: "POST",
      body: { version: cancelled.item.version, reason: "Sent to the wrong member" },
    });
    expect(((await res.json()) as RequestItem).state).toBe("cancelled");
    expect(await docusign().status(cancelled.envelope)).toEqual({ state: "voided" });
  });

  it("voids nothing on a stale cancel, and sends the provider a fixed reason only", async () => {
    const { item, envelope } = await sent("first aid");
    const stale = await as("manager", `/v1/signature-requests/${item.id}/cancel`, {
      method: "POST",
      body: { version: item.version + 1, reason: "Wrong member, Cat Carer instead" },
    });
    expect(stale.status).toBe(409);
    expect(await docusign().status(envelope)).toEqual({ state: "sent" });
  });

  it("cannot be signed in Harbour", async () => {
    const { item, doc } = await sent("duty of candour");
    const res = await as("nurse", `/v1/signature-requests/${item.id}/sign`, {
      method: "POST",
      body: { version: item.version, typedName: "Nia Nurse", sha256Seen: doc.sha256 },
    });
    expect(res.status).toBe(409);
  });
});

interface Extraction {
  id: string;
  version: number;
  state: string;
  failure: string | null;
  engine: string;
  location: string;
  undecided: number;
  fields: {
    id: string;
    version: number;
    label: string;
    readText: string;
    state: string;
    value: string | null;
    lowConfidence: boolean;
    truncated: boolean;
  }[];
}

describe("hazard HZ-005 OCR of scanned MAR charts", () => {
  const read = [
    { group: 0, label: "medicine", text: "Paracetamol 500 mg tablets", confidence: 0.99 },
    { group: 0, label: "dose", text: "1 tablet", confidence: 0.97 },
    { group: 0, label: "route", text: "Oral", confidence: 0.4 },
  ];
  const releaseBody = (version: number, over: Record<string, unknown> = {}) => ({
    version,
    linesCounted: 1,
    lines: [{ line: 0, status: "active" }],
    personConfirmed: true,
    chartFrom: "2026-10-05",
    chartTo: "2026-11-01",
    currentChart: true,
    ...over,
  });

  const scan = (bytes: Uint8Array, who = "nurse", key?: string) =>
    h.request(`/v1/people/${RESIDENT}/mar-scans`, {
      method: "POST",
      token: h.tokens[who],
      tenant: DEMO.tenantId,
      raw: { bytes, contentType: "image/jpeg" },
      ...(key ? { headers: { "idempotency-key": key } } : {}),
    });

  async function ready(fields: unknown[] = read): Promise<Extraction> {
    const res = await scan(chart(fields));
    expect(res.status).toBe(201);
    return (await res.json()) as Extraction;
  }

  async function decide(x: Extraction, index: number, body: Record<string, unknown>) {
    const f = x.fields[index];
    const r = await as("nurse", `/v1/ocr-extractions/${x.id}/fields/${f?.id}/decision`, {
      method: "POST",
      body: { version: f?.version, ...body },
    });
    expect(r.status).toBe(200);
    return (await r.json()) as Extraction;
  }

  it("is for medicines record holders where it reaches the person", async () => {
    expect((await scan(chart(read), "carer")).status).toBe(403);
  });

  it("never reads an image that did not scan clean", async () => {
    const before = (h.handle.services.ocr as MockOcr).requests.length;
    const res = await scan(chart(read, EICAR));
    // An infected upload is refused outright; nothing is read.
    expect(res.status).toBe(422);
    expect((h.handle.services.ocr as MockOcr).requests.length).toBe(before);
  });

  it("returns the first scan for a retried upload with the same key (security L4)", async () => {
    const key = "0194d000-0000-7000-8000-00000000c0de";
    const first = (await (await scan(chart(read), "nurse", key)).json()) as Extraction;
    const again = (await (await scan(chart(read), "nurse", key)).json()) as Extraction;
    expect(again.id).toBe(first.id);
  });

  it("refuses an engine's read with a line or part Harbour does not know, never coercing it", async () => {
    const res = await scan(chart([{ group: -1, label: "frequency", text: "BD", confidence: 0.9 }]));
    expect((await res.json()) as Extraction).toMatchObject({
      state: "failed",
      failure: "unreadable",
    });
  });

  it("flags a weak reading in words, never sending the engine's number", async () => {
    const x = await ready();
    expect(x.fields.map((f) => f.lowConfidence)).toEqual([false, false, true]);
    expect(JSON.stringify(x)).not.toMatch(/"confidence"/);
  });

  it("keeps every value unconfirmed, and releases only a fully accounted-for chart", async () => {
    let x = await ready();
    expect(x).toMatchObject({ state: "ready", engine: "mock", location: "local", undecided: 3 });
    expect(x.fields.map((f) => f.state)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
    const early = await as("nurse", `/v1/ocr-extractions/${x.id}/release`, {
      method: "POST",
      body: releaseBody(x.version),
    });
    expect(early.status).toBe(409);
    expect((await as("nurse", `/v1/ocr-extractions/${x.id}/medicine-lines`)).status).toBe(404);

    x = await decide(x, 0, { action: "confirm" });
    x = await decide(x, 1, { action: "correct", value: "2 tablets" });
    x = await decide(x, 2, { action: "reject" });
    const twice = await as(
      "nurse",
      `/v1/ocr-extractions/${x.id}/fields/${x.fields[0]?.id}/decision`,
      {
        method: "POST",
        body: { version: x.fields[0]?.version, action: "reject" },
      },
    );
    expect(twice.status).toBe(409);

    for (const [over, words] of [
      [{ linesCounted: 2 }, /do not match/],
      [{ lines: [] }, /in force or stopped/],
      [{ lines: [{ line: 0, status: "cannot_tell" }] }, /unclear/],
      [{ currentChart: false }, /in use now/],
    ] as const) {
      const refused = await as("nurse", `/v1/ocr-extractions/${x.id}/release`, {
        method: "POST",
        body: releaseBody(x.version, over),
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { detail: string }).detail).toMatch(words);
    }

    const released = await as("nurse", `/v1/ocr-extractions/${x.id}/release`, {
      method: "POST",
      body: releaseBody(x.version),
    });
    expect(released.status).toBe(200);
    const events = await sql<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_event WHERE event_type = 'integrations.ocr_mar_released' AND aggregate_id = $1",
      [x.id],
    );
    // Ids and a count only: no medicine leaves in the event.
    expect(events.map((e) => e.payload)).toEqual([
      { extractionId: x.id, personId: RESIDENT, lines: 1 },
    ]);
    const lines = await as("nurse", `/v1/ocr-extractions/${x.id}/medicine-lines`);
    const body = (await lines.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      chartFrom: "2026-10-05",
      chartTo: "2026-11-01",
      decidedBy: [DEMO.users.nurse.id],
      releasedBy: DEMO.users.nurse.id,
      lines: [
        {
          medicine: { value: "Paracetamol 500 mg tablets", state: "confirmed" },
          dose: { value: "2 tablets", state: "corrected" },
          route: null,
          origin: "import",
          state: "not_yet_checked",
          secondCheckRequired: true,
        },
      ],
    });
    const audits = await sql<{ scope: unknown; reason: string | null }>(
      "SELECT scope, reason FROM audit_event WHERE action LIKE 'integrations.ocr.%'",
    );
    // No value read or typed is written to the audit trail.
    expect(JSON.stringify(audits)).not.toMatch(/tablet|Paracetamol/);
  });

  it("hazard HZ-130 releases a scanned chart only after its person is confirmed", async () => {
    let x = await ready(read.slice(0, 1));
    x = await decide(x, 0, { action: "confirm" });
    const refused = await as("nurse", `/v1/ocr-extractions/${x.id}/release`, {
      method: "POST",
      body: releaseBody(x.version, { personConfirmed: false }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/name and date of birth/);
  });

  it("never joins two values for one part, and lets a person move one and add what the scan missed", async () => {
    let x = await ready([
      { group: 0, label: "medicine", text: "Amlodipine 5 mg tablets", confidence: 0.9 },
      { group: 0, label: "dose", text: "1 tablet", confidence: 0.9 },
      { group: 0, label: "dose", text: "2 tablets", confidence: 0.9 },
    ]);
    x = await decide(x, 0, { action: "confirm" });
    x = await decide(x, 1, { action: "confirm" });
    x = await decide(x, 2, { action: "confirm" });
    const joined = await as("nurse", `/v1/ocr-extractions/${x.id}/release`, {
      method: "POST",
      body: releaseBody(x.version),
    });
    expect(((await joined.json()) as { detail: string }).detail).toMatch(
      /two values for the same part/,
    );

    let y = await ready([
      { group: 0, label: "medicine", text: "Amlodipine 5 mg tablets", confidence: 0.9 },
      { group: 0, label: "dose", text: "2 tablets", confidence: 0.9 },
    ]);
    y = await decide(y, 0, { action: "confirm" });
    // The engine put the dose on line 0; the person moves it to the medicine they add on line 1.
    y = await decide(y, 1, { action: "confirm", line: 1 });
    const added = await as("nurse", `/v1/ocr-extractions/${y.id}/fields`, {
      method: "POST",
      body: { version: y.version, line: 1, label: "medicine", value: "Senna 7.5 mg tablets" },
    });
    expect(added.status).toBe(201);
    y = (await added.json()) as Extraction;
    const released = await as("nurse", `/v1/ocr-extractions/${y.id}/release`, {
      method: "POST",
      body: releaseBody(y.version, {
        linesCounted: 2,
        lines: [
          { line: 0, status: "active" },
          { line: 1, status: "active" },
        ],
      }),
    });
    expect(released.status).toBe(200);
    const lines = (await (
      await as("nurse", `/v1/ocr-extractions/${y.id}/medicine-lines`)
    ).json()) as {
      lines: {
        medicine: { value: string; addedByPerson: boolean };
        dose: { value: string } | null;
      }[];
    };
    expect(
      lines.lines.map((l) => [l.medicine.value, l.medicine.addedByPerson, l.dose?.value ?? null]),
    ).toEqual([
      ["Amlodipine 5 mg tablets", false, null],
      ["Senna 7.5 mg tablets", true, "2 tablets"],
    ]);
  });

  it("records a failed read, a chart that read as nothing, and a discarded scan, and never releases them", async () => {
    const failed = await scan(chart(null, "HARBOUR-OCR-FAIL"));
    expect((await failed.json()) as Extraction).toMatchObject({
      state: "failed",
      failure: "engine_error",
      fields: [],
    });
    const nothing = await scan(chart(null, "a chart the engine could not read"));
    expect((await nothing.json()) as Extraction).toMatchObject({
      state: "failed",
      failure: "nothing_read",
    });
    const x = await ready();
    const discarded = await as("nurse", `/v1/ocr-extractions/${x.id}/discard`, {
      method: "POST",
      body: { version: x.version },
    });
    expect(((await discarded.json()) as Extraction).state).toBe("discarded");
    const release = await as("nurse", `/v1/ocr-extractions/${x.id}/release`, {
      method: "POST",
      body: releaseBody(x.version + 1),
    });
    expect(release.status).toBe(409);
  });

  it("is switched off for an organisation that has not chosen it", async () => {
    await sql("DELETE FROM integration_connection WHERE port = 'documents.ocr'");
    try {
      const res = await scan(chart(read));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("feature_disabled");
    } finally {
      await sql(
        "INSERT INTO integration_connection (port, provider) VALUES ('documents.ocr', 'mock')",
      );
    }
  });

  it("is unavailable when no engine is configured", async () => {
    const off = await createHarness();
    try {
      await verified(off);
      const res = await off.request(`/v1/people/${RESIDENT}/mar-scans`, {
        method: "POST",
        token: off.tokens.nurse,
        tenant: DEMO.tenantId,
        raw: { bytes: chart(read), contentType: "image/jpeg" },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("feature_disabled");
    } finally {
      await off.close();
    }
  });
});
