import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * The compliance framework and evidence library through the API (quality.md section 18;
 * QUAL-001, QUAL-002; ADR-0096; migration 0076): the seeded framework in force, the organisation's
 * versioned mapping, evidence links read in the tagger's scope and removed with a reason, coverage
 * with its gaps, the evidence pack taking statement ids from the framework, and every change and
 * refusal audited.
 */

let h: Harness;
const FW = "0192f1a0-0000-7000-8000-000000000001";

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let noteId: string;

beforeAll(async () => {
  h = await createHarness();
  const [person] = await sql<{ id: string }>(
    "SELECT id FROM person WHERE location_id = $1 AND status = 'active' ORDER BY id LIMIT 1",
    [DEMO.locationId],
  );
  const [row] = await sql<{ id: string }>(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by)
     VALUES ($1, $2, now(), 'mood', 'Enjoyed the garden', $3) RETURNING id`,
    [person?.id, DEMO.locationId, DEMO.users.carer.id],
  );
  noteId = row?.id as string;
});

afterAll(async () => {
  await h?.close();
});

describe("the compliance framework (QUAL-001; ADR-0096)", () => {
  it("lists CQC's version 1 as in force, with its 5 key questions, 34 statements and 6 categories", async () => {
    const list = await as("manager", "/v1/quality/frameworks");
    expect(list.status).toBe(200);
    const { items } = (await list.json()) as {
      items: { id: string; inForce: boolean; regulator: string }[];
    };
    expect(items.find((i) => i.id === FW)).toMatchObject({ inForce: true, regulator: "cqc" });
    const detail = (await (await as("manager", `/v1/quality/frameworks/${FW}`)).json()) as {
      keyQuestions: { id: string; statements: unknown[] }[];
      evidenceCategories: unknown[];
      source: { url: string };
    };
    expect(detail.keyQuestions.map((q) => q.id)).toEqual([
      "safe",
      "effective",
      "caring",
      "responsive",
      "well-led",
    ]);
    expect(detail.keyQuestions.flatMap((q) => q.statements)).toHaveLength(34);
    expect(detail.evidenceCategories).toHaveLength(6);
    expect(detail.source.url).toMatch(/^https:\/\/www\.cqc\.org\.uk\//);
  });

  it("is not for someone who does not work with quality evidence", async () => {
    expect((await as("carer", "/v1/quality/frameworks")).status).toBe(403);
    expect(
      (await as("manager", "/v1/quality/frameworks/0192f1a0-0000-7000-8000-0000000000ff")).status,
    ).toBe(404);
  });
});

describe("hazard HZ-011 the organisation's framework mapping (rule 5)", () => {
  const entry = {
    statementId: "safe.safeguarding",
    localTitle: "Keeping people safe from abuse",
    ownerRole: "registered_manager",
    evidenceCategoryIds: ["processes", "outcomes"],
  };

  it("starts unmapped, saves the next version, refuses a stale one and keeps the history", async () => {
    const empty = (await (await as("manager", `/v1/quality/frameworks/${FW}/mapping`)).json()) as {
      mappingVersion: number;
    };
    expect(empty.mappingVersion).toBe(0);
    const first = await as("manager", `/v1/quality/frameworks/${FW}/mapping`, {
      method: "PUT",
      body: { mappingVersion: 1, entries: [entry] },
    });
    expect(first.status).toBe(201);
    const before = new Date().toISOString();
    const stale = await as("manager", `/v1/quality/frameworks/${FW}/mapping`, {
      method: "PUT",
      body: { mappingVersion: 1, entries: [] },
    });
    expect(stale.status).toBe(409);
    const second = await as("manager", `/v1/quality/frameworks/${FW}/mapping`, {
      method: "PUT",
      body: { mappingVersion: 2, entries: [] },
    });
    expect(second.status).toBe(201);
    const then = (await (
      await as("manager", `/v1/quality/frameworks/${FW}/mapping?at=${encodeURIComponent(before)}`)
    ).json()) as { mappingVersion: number; entries: unknown[] };
    expect(then).toMatchObject({ mappingVersion: 1, entries: [entry] });
  });

  it("refuses a statement or evidence category the framework does not have, in words", async () => {
    const response = await as("manager", `/v1/quality/frameworks/${FW}/mapping`, {
      method: "PUT",
      body: { mappingVersion: 3, entries: [{ ...entry, statementId: "safe.made_up" }] },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { detail: string }).detail).toContain(
      "not in this framework version",
    );
    const audits = await sql<{ outcome: string }>(
      "SELECT outcome FROM audit_event WHERE action = 'quality.framework.mapping_changed' ORDER BY occurred_at",
    );
    expect(audits.map((a) => a.outcome)).toEqual(expect.arrayContaining(["success", "denied"]));
  });

  it("is the quality lead's: a care worker can neither read nor change it", async () => {
    expect((await as("carer", `/v1/quality/frameworks/${FW}/mapping`)).status).toBe(403);
  });
});

describe("hazard HZ-011 evidence links (rules 6 and 7)", () => {
  let linkId: string;

  it("tags a record the tagger can see, against real statements, audited", async () => {
    const response = await as("manager", "/v1/evidence-links", {
      method: "POST",
      body: {
        recordType: "care_note",
        recordId: noteId,
        frameworkVersionId: FW,
        statementIds: [
          "caring.kindness_compassion_and_dignity",
          "caring.kindness_compassion_and_dignity",
        ],
      },
    });
    expect(response.status).toBe(201);
    const link = (await response.json()) as { id: string; statementIds: string[]; version: number };
    linkId = link.id;
    expect(link.statementIds).toEqual(["caring.kindness_compassion_and_dignity"]);
    const audits = await sql<{ action: string }>(
      "SELECT action FROM audit_event WHERE resource_id = $1",
      [linkId],
    );
    expect(audits.map((a) => a.action)).toContain("quality.evidence.tagged");
  });

  it.each<[string, Record<string, unknown>, number]>([
    ["an unknown statement", { statementIds: ["caring.made_up"] }, 422],
    ["a record type whose records are not in Harbour yet", { recordType: "compliment" }, 422],
    ["a record type that is never evidence", { recordType: "payslip" }, 422],
    ["a record that does not exist", { recordId: "0192f1a0-0000-7000-8000-0000000000aa" }, 404],
  ])("refuses %s", async (_, over, status) => {
    const response = await as("manager", "/v1/evidence-links", {
      method: "POST",
      body: {
        recordType: "care_note",
        recordId: noteId,
        frameworkVersionId: FW,
        statementIds: ["safe.safeguarding"],
        ...over,
      },
    });
    expect(response.status).toBe(status);
  });

  it("lists links by record and by statement, and counts coverage with its gaps", async () => {
    const byRecord = (await (
      await as("manager", `/v1/evidence-links?recordType=care_note&recordId=${noteId}`)
    ).json()) as { items: { id: string }[] };
    expect(byRecord.items.map((i) => i.id)).toContain(linkId);
    const byStatement = (await (
      await as(
        "manager",
        `/v1/evidence-links?frameworkVersionId=${FW}&statementId=caring.kindness_compassion_and_dignity`,
      )
    ).json()) as { items: { id: string }[] };
    expect(byStatement.items.map((i) => i.id)).toContain(linkId);
    const coverage = (await (
      await as("manager", `/v1/quality/frameworks/${FW}/coverage`)
    ).json()) as {
      statements: { statementId: string; records: number }[];
      gaps: string[];
    };
    expect(
      coverage.statements.find((s) => s.statementId === "caring.kindness_compassion_and_dignity")
        ?.records,
    ).toBe(1);
    expect(coverage.gaps).toContain("safe.safeguarding");
    expect((await as("manager", "/v1/evidence-links")).status).toBe(422);
  });

  it("removes a tag once, with a reason, and it no longer counts", async () => {
    const remove = (version: number) =>
      as("manager", `/v1/evidence-links/${linkId}/remove`, {
        method: "POST",
        body: { reason: "Tagged against the wrong statement", version },
      });
    const removed = await remove(1);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { removedAt: string | null }).removedAt).not.toBeNull();
    expect((await remove(2)).status).toBe(409);
    const coverage = (await (
      await as("manager", `/v1/quality/frameworks/${FW}/coverage`)
    ).json()) as {
      gaps: string[];
    };
    expect(coverage.gaps).toContain("caring.kindness_compassion_and_dignity");
  });

  it("is the quality lead's: a care worker cannot tag or list", async () => {
    expect(
      (
        await as("carer", "/v1/evidence-links", {
          method: "POST",
          body: {
            recordType: "care_note",
            recordId: noteId,
            frameworkVersionId: FW,
            statementIds: ["safe.safeguarding"],
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (await as("carer", `/v1/evidence-links?recordType=care_note&recordId=${noteId}`)).status,
    ).toBe(403);
  });
});

describe("hazard HZ-050 the evidence pack takes its statement ids from the framework", () => {
  const compose = async (ids: string[] | null) =>
    as("manager", "/v1/evidence-packs", {
      method: "POST",
      body: {
        recipient: { name: "Ivy Inspector", organisation: "CQC", email: "ivy@example.invalid" },
        purpose: "Assessment of Harbour House, safe key question",
        from: "2026-01-01",
        to: new Date().toISOString().slice(0, 10),
        locationIds: [DEMO.locationId],
        qualityStatementIds: ids,
        personIds: [
          (
            await sql<{ id: string }>("SELECT person_id AS id FROM care_note WHERE id = $1", [
              noteId,
            ])
          )[0]?.id,
        ],
      },
    });

  it.each<[string, string[] | null, number]>([
    ["every statement", null, 201],
    ["a key question, as the screens send", ["safe", "well-led"], 201],
    ["a quality statement", ["safe.safeguarding"], 201],
    ["an id the framework does not know", ["safe.1"], 422],
  ])("composes with %s", async (_, ids, status) => {
    expect((await compose(ids)).status).toBe(status);
  });
});
