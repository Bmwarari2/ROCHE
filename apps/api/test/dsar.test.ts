import { DEMO } from "@harbour/db/seed";
import { touchesCareRecords } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The DSAR workbench through the API (PLAT-022; platform.md, Phase 2: the DSAR workbench; ADR-0090;
 * migration 0077): cases for people, contacts and staff; identity, pauses and the extension on the
 * slice 9 clock; collection across modules from the export catalogue; redaction decided by a
 * person; the bundle; rectification and erasure recorded; portability where it applies; refusals;
 * audit scopes without names. Invented people only.
 */

let h: Harness;
let ada: string;
let adaContact: string;
let adaNote: string;

const as = (who: string, tenant: string = DEMO.tenantId) => ({ token: h.tokens[who], tenant });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const get = (path: string, who = "quality") => send("GET", path, who);
const post = (path: string, body: unknown, who = "quality") => send("POST", path, who, body);
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

type Clock = {
  state: string;
  dueOn: string | null;
  pausedDays: number;
  extended: boolean;
  late: boolean | null;
};
type Case = {
  id: string;
  version: number;
  status: string;
  clock: Clock | null;
  subject: { kind: string; name: string };
  items: { total: number; pending: number; disclosed: number; withheld: number };
  notSearched: string[];
  portability: { applies: boolean };
  bundleSha256: string | null;
  erasure: { held: number; retained: number; erasable: number } | null;
  rectification: unknown[];
};
type Item = { id: string; tableName: string; recordId: string; decision: string; version: number };

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function owner<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } finally {
    client.release();
  }
}

async function newCase(body: Record<string, unknown>): Promise<Case> {
  const r = await post("/v1/dsar-cases", {
    requestKind: "access",
    subjectKind: "person",
    subjectPersonId: ada,
    requesterKind: "subject",
    channel: "email",
    receivedOn: isoDaysAgo(3),
    identityRequired: false,
    ...body,
  });
  expect(r.status).toBe(201);
  return (await r.json()) as Case;
}

beforeAll(async () => {
  h = await createHarness();
  const [p] = await owner<{ id: string }>(
    "SELECT id FROM person WHERE given_name = 'Ada' AND family_name = 'Example'",
  );
  ada = p?.id as string;
  const [ct] = await owner<{ id: string }>("SELECT id FROM contact WHERE person_id = $1 LIMIT 1", [
    ada,
  ]);
  adaContact = ct?.id as string;
  const [note] = await owner<{ id: string }>(
    `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
     VALUES ($1, $2, 'visit', 'Visited by Relative Example and Mo Manager. Ada enjoyed it.', now())
     RETURNING id`,
    [ada, DEMO.locationId],
  );
  adaNote = note?.id as string;
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("PLAT-022 only holders of quality.dsar.manage, with MFA", () => {
  it("is a care-record permission, so MFA is required", () => {
    expect(touchesCareRecords("quality.dsar.manage")).toBe(true);
  });

  it("refuses a care worker and a member with no role", async () => {
    expect((await get("/v1/dsar-cases", "carer")).status).toBe(403);
    expect((await get("/v1/dsar-cases", "agency")).status).toBe(403);
  });

  it("refuses a subject in another organisation, and hides cases across organisations", async () => {
    const r = await post("/v1/dsar-cases", {
      requestKind: "access",
      subjectKind: "person",
      subjectPersonId: OTHER.personId,
      requesterKind: "subject",
      channel: "email",
      receivedOn: isoDaysAgo(1),
    });
    expect(r.status).toBe(422);
    const mine = await newCase({});
    const rae = await send("GET", `/v1/dsar-cases/${mine.id}`, "rae", undefined);
    expect([403, 404]).toContain(rae.status);
    const raeList = await h.request("/v1/dsar-cases", {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
    });
    if (raeList.status === 200)
      expect(((await raeList.json()) as { items: Case[] }).items.map((c) => c.id)).not.toContain(
        mine.id,
      );
  });
});

describe("cases and the clock", () => {
  it.each([
    [
      "a representative without an authority",
      { requesterKind: "representative", requesterName: "Eve Example" },
    ],
    ["a contact case without the contact", { subjectKind: "contact" }],
    ["a request received in the future", { receivedOn: isoDaysAgo(-2) }],
  ])("refuses %s", async (_name, body) => {
    const r = await post("/v1/dsar-cases", {
      requestKind: "access",
      subjectKind: "person",
      subjectPersonId: ada,
      requesterKind: "subject",
      channel: "email",
      receivedOn: isoDaysAgo(1),
      ...body,
    });
    expect(r.status).toBe(422);
  });

  it("waits for identity, then runs, pauses, resumes and extends on the slice 9 clock", async () => {
    let c = await newCase({
      identityRequired: true,
      requesterKind: "representative",
      requesterName: "Eve Example",
      authority: "lpa_health_welfare",
    });
    expect(c.clock?.state).toBe("awaiting_identity");
    let r = await post(`/v1/dsar-cases/${c.id}/identity`, {
      verifiedOn: isoDaysAgo(2),
      method: "authority_checked",
      expectedVersion: c.version,
    });
    expect(r.status).toBe(200);
    c = (await r.json()) as Case;
    expect(c.clock?.state).toBe("running");
    const due = c.clock?.dueOn;

    r = await post(`/v1/dsar-cases/${c.id}/pauses`, {
      from: isoDaysAgo(1),
      expectedVersion: c.version,
    });
    c = (await r.json()) as Case;
    expect(c.clock?.state).toBe("paused");
    // A second open pause is refused.
    r = await post(`/v1/dsar-cases/${c.id}/pauses`, {
      from: isoDaysAgo(0),
      expectedVersion: c.version,
    });
    expect(r.status).toBe(422);
    r = await post(`/v1/dsar-cases/${c.id}/pauses/end`, {
      to: isoDaysAgo(0),
      expectedVersion: c.version,
    });
    c = (await r.json()) as Case;
    expect(c.clock?.pausedDays).toBe(1);
    expect(c.clock?.dueOn && due && c.clock.dueOn >= due).toBe(true);

    // A stale version is refused.
    r = await post(`/v1/dsar-cases/${c.id}/extension`, {
      months: 1,
      grounds: "complex",
      reason: "Records across several services",
      decidedOn: isoDaysAgo(0),
      expectedVersion: c.version - 1,
    });
    expect(r.status).toBe(409);
    // Beyond the rate table's months is refused in the rule's words.
    r = await post(`/v1/dsar-cases/${c.id}/extension`, {
      months: 3,
      grounds: "complex",
      reason: "Records across several services",
      decidedOn: isoDaysAgo(0),
      expectedVersion: c.version,
    });
    expect(r.status).toBe(422);
    expect(await codeOf(r)).toBe("extension_too_long");
    r = await post(`/v1/dsar-cases/${c.id}/extension`, {
      months: 2,
      grounds: "complex",
      reason: "Records across several services",
      decidedOn: isoDaysAgo(0),
      expectedVersion: c.version,
    });
    expect(r.status).toBe(200);
    c = (await r.json()) as Case;
    expect(c.clock?.extended).toBe(true);
  });

  it("refuses an extension decided after the original due date", async () => {
    const c = await newCase({ receivedOn: isoDaysAgo(70) });
    expect(c.clock?.state).toBe("overdue");
    const r = await post(`/v1/dsar-cases/${c.id}/extension`, {
      months: 1,
      grounds: "multiple_requests",
      reason: "Several requests together",
      decidedOn: isoDaysAgo(0),
      expectedVersion: c.version,
    });
    expect(r.status).toBe(422);
    expect(await codeOf(r)).toBe("extension_too_late");
  });
});

describe("collection, review and the bundle", () => {
  let c: Case;
  let items: Item[];

  it("collects a person's records from several modules, and again adds nothing", async () => {
    c = await newCase({});
    let r = await post(`/v1/dsar-cases/${c.id}/collect`, {});
    expect(r.status).toBe(200);
    const first = (await r.json()) as { added: number; total: number; notSearched: string[] };
    expect(first.added).toBeGreaterThan(2);
    expect(first.notSearched.length).toBeGreaterThan(0);
    r = await post(`/v1/dsar-cases/${c.id}/collect`, {});
    expect(((await r.json()) as { added: number }).added).toBe(0);
    items = ((await (await get(`/v1/dsar-cases/${c.id}/items`)).json()) as { items: Item[] }).items;
    const tables = new Set(items.map((i) => i.tableName));
    expect(tables).toContain("person");
    expect(tables).toContain("care_note");
    expect(tables).toContain("contact");
    expect(items.some((i) => i.recordId === adaNote)).toBe(true);
  });

  it("shows a record with other people's names highlighted, redacting nothing, and audits the view", async () => {
    const note = items.find((i) => i.recordId === adaNote) as Item;
    const r = await get(`/v1/dsar-cases/${c.id}/items/${note.id}`);
    expect(r.status).toBe(200);
    const detail = (await r.json()) as {
      record: Record<string, unknown>;
      highlights: { field: string; name: string }[];
    };
    expect(detail.record.body).toContain("Relative Example");
    expect(detail.highlights.map((x) => x.name)).toEqual(
      expect.arrayContaining(["Relative Example", "Mo Manager"]),
    );
    expect(detail.highlights.map((x) => x.name)).not.toContain("Ada");
    const audits = await owner<{ scope: Record<string, unknown> }>(
      "SELECT scope FROM audit_event WHERE action = 'platform.dsar.item_viewed' AND resource_id = $1",
      [c.id],
    );
    expect(audits).toHaveLength(1);
  });

  it("refuses a redaction without fields or a reason, and the bundle until every record is decided", async () => {
    const note = items.find((i) => i.recordId === adaNote) as Item;
    let r = await post(`/v1/dsar-cases/${c.id}/items/${note.id}/decision`, {
      decision: "redact",
      reason: "Third-party data",
      expectedVersion: note.version,
    });
    expect(r.status).toBe(422);
    r = await post(`/v1/dsar-cases/${c.id}/items/${note.id}/decision`, {
      decision: "withhold",
      expectedVersion: note.version,
    });
    expect(r.status).toBe(422);
    r = await get(`/v1/dsar-cases/${c.id}/bundle`);
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("dsar_bundle_not_ready");
  });

  it("issues the bundle with redactions and withheld records left out, and records its hash on respond", async () => {
    const note = items.find((i) => i.recordId === adaNote) as Item;
    const others = items.filter((i) => i.id !== note.id);
    let r = await post(`/v1/dsar-cases/${c.id}/items/${note.id}/decision`, {
      decision: "redact",
      redactedFields: ["body"],
      reason: "Third-party data (DPA 2018 Sch 2 para 16)",
      expectedVersion: note.version,
    });
    expect(r.status).toBe(200);
    const [withheld, ...rest] = others;
    r = await post(`/v1/dsar-cases/${c.id}/items/${withheld?.id}/decision`, {
      decision: "withhold",
      reason: "Serious harm test (DPA 2018 Sch 3 para 5)",
      expectedVersion: withheld?.version,
    });
    expect(r.status).toBe(200);
    for (const i of rest) {
      r = await post(`/v1/dsar-cases/${c.id}/items/${i.id}/decision`, {
        decision: "disclose",
        expectedVersion: i.version,
      });
      expect(r.status).toBe(200);
    }
    r = await get(`/v1/dsar-cases/${c.id}/bundle`);
    expect(r.status).toBe(200);
    const bundle = (await r.json()) as {
      records: { table: string; recordId: string; fields: Record<string, unknown> }[];
      withheldCount: number;
      redactedCount: number;
      sha256: string;
    };
    expect(bundle.withheldCount).toBe(1);
    expect(bundle.redactedCount).toBe(1);
    expect(bundle.records.find((x) => x.recordId === adaNote)?.fields.body).toBe("[redacted]");
    expect(bundle.records.some((x) => x.recordId === withheld?.recordId)).toBe(false);
    expect(bundle.records).toHaveLength(items.length - 1);
    // Secret and internal columns never leave.
    for (const rec of bundle.records) expect(Object.keys(rec.fields)).not.toContain("search_body");

    // Portability does not apply to a person's care records.
    r = await get(`/v1/dsar-cases/${c.id}/bundle?format=portable`);
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("dsar_portability_not_applicable");

    const fresh = (await (await get(`/v1/dsar-cases/${c.id}`)).json()) as Case;
    r = await post(`/v1/dsar-cases/${c.id}/respond`, {
      respondedOn: isoDaysAgo(0),
      outcome: "partly_fulfilled",
      expectedVersion: fresh.version,
    });
    expect(r.status).toBe(422);
    r = await post(`/v1/dsar-cases/${c.id}/respond`, {
      respondedOn: isoDaysAgo(0),
      outcome: "partly_fulfilled",
      outcomeReason: "One record withheld under the serious harm test.",
      expectedVersion: fresh.version,
    });
    expect(r.status).toBe(200);
    const closed = (await r.json()) as Case;
    expect(closed.status).toBe("closed");
    expect(closed.clock?.state).toBe("closed");
    expect(closed.clock?.late).toBe(false);
    expect(closed.bundleSha256).toBe(bundle.sha256);
    // A closed case takes no more decisions.
    r = await post(`/v1/dsar-cases/${c.id}/collect`, {});
    expect(r.status).toBe(409);
  });
});

describe("contacts, staff, rectification and erasure", () => {
  it("collects a contact's own records, and a member of staff's", async () => {
    const contactCase = await newCase({ subjectKind: "contact", subjectContactId: adaContact });
    expect(contactCase.subject.kind).toBe("contact");
    expect(contactCase.portability.applies).toBe(false);
    let r = await post(`/v1/dsar-cases/${contactCase.id}/collect`, {});
    expect(((await r.json()) as { total: number }).total).toBeGreaterThanOrEqual(1);
    const contactItems = (
      (await (await get(`/v1/dsar-cases/${contactCase.id}/items`)).json()) as { items: Item[] }
    ).items;
    expect(contactItems.every((i) => i.tableName !== "person")).toBe(true);

    const staffCase = await newCase({
      requestKind: "portability",
      subjectKind: "staff",
      subjectPersonId: null,
      subjectStaffId: LODGE.qualityLeadId,
    });
    expect(staffCase.portability.applies).toBe(true);
    r = await post(`/v1/dsar-cases/${staffCase.id}/collect`, {});
    expect(r.status).toBe(200);
    const staffItems = (
      (await (await get(`/v1/dsar-cases/${staffCase.id}/items`)).json()) as { items: Item[] }
    ).items;
    expect(staffItems.map((i) => i.tableName)).toContain("tenant_user");
  });

  it("records rectification decisions only on a rectification request", async () => {
    const access = await newCase({});
    const decision = {
      table: "person",
      recordId: ada,
      field: "preferred_name",
      decision: "corrected",
      reason: "Corrected in the record by a new version.",
      decidedOn: isoDaysAgo(0),
    };
    let r = await post(`/v1/dsar-cases/${access.id}/rectification`, {
      decisions: [decision],
      expectedVersion: access.version,
    });
    expect(r.status).toBe(409);
    const rect = await newCase({ requestKind: "rectification" });
    r = await post(`/v1/dsar-cases/${rect.id}/rectification`, {
      decisions: [decision],
      expectedVersion: rect.version,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Case).rectification).toHaveLength(1);
  });

  it("assesses erasure against retention and records it, deleting nothing", async () => {
    const er = await newCase({ requestKind: "erasure" });
    let r = await post(`/v1/dsar-cases/${er.id}/erasure`, { expectedVersion: er.version });
    expect(r.status).toBe(409);
    await post(`/v1/dsar-cases/${er.id}/collect`, {});
    const fresh = (await (await get(`/v1/dsar-cases/${er.id}`)).json()) as Case;
    r = await post(`/v1/dsar-cases/${er.id}/erasure`, { expectedVersion: fresh.version });
    expect(r.status).toBe(200);
    const assessed = (await r.json()) as Case;
    // Ada is still receiving care: nothing of her care record may go.
    expect(assessed.erasure?.erasable).toBe(0);
    expect(assessed.erasure?.retained).toBe(fresh.items.total);
    const [still] = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM person WHERE id = $1",
      [ada],
    );
    expect(still?.n).toBe(1);
  });
});

describe("audit holds counts and ids, never names or content", () => {
  it("has no requester name, subject name or record text in any scope", async () => {
    const rows = await owner<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action LIKE 'platform.dsar.%'",
    );
    expect(rows.length).toBeGreaterThan(10);
    const text = JSON.stringify(rows);
    for (const name of ["Eve Example", "Ada", "Relative Example", "Visited by"])
      expect(text).not.toContain(name);
  });
});
