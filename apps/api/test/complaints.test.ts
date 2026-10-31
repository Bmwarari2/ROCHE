import type {
  ComplaintItem,
  ComplaintList,
  ComplimentItem,
  ProblemDetails,
  WorkflowInstanceList,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Complaints and compliments through the API (Phase 2 slice 18; SAFE-011; Regulation 16). The
 * Registered Manager manages complaints at Harbour House; the care worker does not. Invented
 * complainants only.
 */

let h: Harness;
let documentId = "";
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown; tenant?: string } = {},
) => h.request(path, { token: h.tokens[user], tenant: init.tenant ?? DEMO.tenantId, ...init });

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

const newComplaint = (over: Record<string, unknown> = {}) => ({
  locationId: DEMO.locationId,
  complainantName: "Pat Example",
  complainantRelationship: "family_or_friend",
  complainantContact: "pat.example@example.invalid",
  channel: "email",
  receivedAt: ago(DAY),
  knewOfMatterOn: ago(3 * DAY).slice(0, 10),
  summary: "Lunch arrives cold most days.",
  ...over,
});

async function record(over: Record<string, unknown> = {}) {
  const response = await as("manager", "/v1/complaints", {
    method: "POST",
    body: newComplaint(over),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return json<ComplaintItem>(response);
}

const step = (id: string, body: Record<string, unknown>) =>
  as("manager", `/v1/complaints/${id}/step`, { method: "POST", body });

const instance = (id: string) =>
  asDemoTenant(async (c) => {
    const { rows } = await c.query<{ state: string; sla_due_at: Date | null }>(
      "SELECT state, sla_due_at FROM workflow_instance WHERE subject_type = 'complaint' AND subject_id = $1",
      [id],
    );
    return rows[0];
  });

beforeAll(async () => {
  h = await createHarness();
  documentId = await asDemoTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type,
         size_bytes, sha256)
       VALUES ('correspondence', 'Complaint response', 'complaint', 'fixture/response',
               'application/pdf', 10, repeat('0', 64))
       RETURNING id`,
    );
    return rows[0]?.id as string;
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("SAFE-011 complaints (Regulation 16)", () => {
  it("records a complaint with its targets, the Ombudsman's time limit and the workflow deadline", async () => {
    const created = await record();
    expect(created).toMatchObject({
      state: "received",
      complainantName: "Pat Example",
      recordedBy: { id: DEMO.users.manager.id },
      ombudsman: { wording: expect.stringContaining("Local Government and Social Care Ombudsman") },
    });
    expect(created.clocks.wording).toContain("Regulation 16 sets none");
    const wf = await instance(created.id);
    expect(wf?.state).toBe("received");
    // The end of the acknowledgement target's last day.
    expect(wf?.sla_due_at?.toISOString().slice(0, 10)).toBe(
      new Date(Date.parse(`${created.clocks.acknowledgeBy}T12:00:00Z`) + DAY)
        .toISOString()
        .slice(0, 10),
    );
  });

  it("moves through acknowledgement and investigation, with the response target written onto the workflow", async () => {
    const created = await record();
    const acknowledged = await json<ComplaintItem>(
      await step(created.id, { to: "acknowledged", version: created.version }),
    );
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    const investigating = await step(created.id, {
      to: "investigating",
      version: acknowledged.version,
    });
    expect(investigating.status).toBe(200);
    const wf = await instance(created.id);
    expect(wf?.state).toBe("investigating");
    expect(wf?.sla_due_at).not.toBeNull();
  });

  it("refuses a response without the Ombudsman signposted, in words, then takes a complete one", async () => {
    let current = await record();
    current = await json<ComplaintItem>(
      await step(current.id, { to: "acknowledged", version: current.version }),
    );
    const refused = await step(current.id, {
      to: "responded",
      version: current.version,
      response: {
        outcome: "partly_upheld",
        actionsTaken: "Hot trolleys bought for the dining room.",
        ombudsmanSignposted: false,
        documentId,
      },
    });
    expect(refused.status).toBe(422);
    expect((await json<ProblemDetails>(refused)).detail).toMatch(/Ombudsman/);
    const responded = await step(current.id, {
      to: "responded",
      version: current.version,
      response: {
        outcome: "partly_upheld",
        actionsTaken: "Hot trolleys bought for the dining room.",
        ombudsmanSignposted: true,
        documentId,
      },
    });
    expect(responded.status, await responded.clone().text()).toBe(200);
    const after = await json<ComplaintItem>(responded);
    expect(after).toMatchObject({ state: "responded", response: { outcome: "partly_upheld" } });
    // No deadline once responded.
    expect((await instance(current.id))?.sla_due_at).toBeNull();

    // An appeal needs when it arrived and why; then its response; then it closes with a reason.
    const noAppeal = await step(current.id, { to: "appealed", version: after.version });
    expect(noAppeal.status).toBe(422);
    const appealed = await json<ComplaintItem>(
      await step(current.id, {
        to: "appealed",
        version: after.version,
        appeal: { receivedAt: ago(60_000), reason: "The trolleys have not arrived." },
      }),
    );
    expect(appealed.state).toBe("appealed");
    const appealResponded = await json<ComplaintItem>(
      await step(current.id, {
        to: "appeal_responded",
        version: appealed.version,
        response: {
          outcome: "upheld",
          actionsTaken: "The trolleys arrived on Monday.",
          ombudsmanSignposted: true,
          documentId,
        },
      }),
    );
    expect(appealResponded.appealResponse?.outcome).toBe("upheld");
    const noReason = await step(current.id, { to: "closed", version: appealResponded.version });
    expect(noReason.status).toBe(422);
    const closed = await json<ComplaintItem>(
      await step(current.id, {
        to: "closed",
        version: appealResponded.version,
        reason: "Resolved after the appeal response.",
      }),
    );
    expect(closed).toMatchObject({
      state: "closed",
      closedReason: "Resolved after the appeal response.",
    });
  });

  it("moves the response target by the working days paused", async () => {
    const created = await record({ receivedAt: ago(2 * DAY) });
    const from = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 13 * DAY).toISOString().slice(0, 10);
    const response = await as("manager", `/v1/complaints/${created.id}/pauses`, {
      method: "PUT",
      body: {
        pauses: [{ from, to, reason: "Waiting for the complainant's consent." }],
        version: created.version,
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const paused = await json<ComplaintItem>(response);
    expect(paused.clocks.pausedWorkingDays).toBeGreaterThan(0);
    expect(paused.clocks.respondBy > created.clocks.respondBy).toBe(true);
    const bad = await as("manager", `/v1/complaints/${created.id}/pauses`, {
      method: "PUT",
      body: { pauses: [{ from: to, to: from, reason: "Backwards." }], version: paused.version },
    });
    expect(bad.status).toBe(422);
  });

  it("shows the complaint on the approvals list with its deadline", async () => {
    const created = await record();
    const list = await json<WorkflowInstanceList>(await as("manager", "/v1/workflows?view=all"));
    expect(list.items.find((i) => i.subjectId === created.id)).toMatchObject({
      definitionKey: "safety.complaint",
      state: "received",
    });
    expect(list.items.find((i) => i.subjectId === created.id)?.slaDueAt).not.toBeNull();
  });

  it("refuses a member without the permission, and a home where the reader does not hold it", async () => {
    expect((await as("carer", "/v1/complaints")).status).toBe(403);
    const lodge = await as("manager", "/v1/complaints", {
      method: "POST",
      body: newComplaint({ locationId: LODGE.locationId }),
    });
    expect(lodge.status).toBe(403);
  });

  it("refuses a receipt in the future, and knowing of it after it arrived", async () => {
    const future = await as("manager", "/v1/complaints", {
      method: "POST",
      body: newComplaint({ receivedAt: new Date(Date.now() + DAY).toISOString() }),
    });
    expect(future.status).toBe(422);
    const knewLater = await as("manager", "/v1/complaints", {
      method: "POST",
      body: newComplaint({
        knewOfMatterOn: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10),
      }),
    });
    expect(knewLater.status).toBe(422);
  });

  it("never shows another organisation's complaints", async () => {
    await record();
    const response = await as("rae", "/v1/complaints", { tenant: OTHER.tenantId });
    if (response.status === 200) {
      expect((await json<ComplaintList>(response)).items).toEqual([]);
    } else {
      expect(response.status).toBe(403);
    }
  });

  it("audits by id only, never the complainant's details", async () => {
    const created = await record();
    const events = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{
        action: string;
        scope: unknown;
        before: unknown;
        after: unknown;
      }>("SELECT action, scope, reason FROM audit_event WHERE resource_id = $1", [created.id]);
      return rows;
    });
    expect(events.map((e) => e.action)).toContain("safety.complaint.create");
    expect(JSON.stringify(events)).not.toContain("Pat Example");
    const outbox = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ payload: unknown }>(
        "SELECT payload FROM outbox_event WHERE aggregate_id = $1",
        [created.id],
      );
      return rows;
    });
    expect(JSON.stringify(outbox)).not.toContain("Pat Example");
  });
});

describe("SAFE-011 compliments", () => {
  it("records a compliment with the staff it praises and tags it as evidence, never with a clock", async () => {
    const response = await as("manager", "/v1/compliments", {
      method: "POST",
      body: {
        locationId: DEMO.locationId,
        fromName: "Sam Example",
        fromRelationship: "family_or_friend",
        receivedAt: ago(DAY),
        summary: "Thank you for the birthday tea.",
        staffIds: [DEMO.users.carer.id],
        evidenceStatementIds: ["caring.kindness"],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const created = await json<ComplimentItem>(response);
    expect(created.staff.map((s) => s.id)).toEqual([DEMO.users.carer.id]);
    const tagged = await as("manager", `/v1/compliments/${created.id}/evidence`, {
      method: "PUT",
      body: {
        evidenceStatementIds: ["caring.kindness", "responsive.person_centred"],
        version: created.version,
      },
    });
    expect(tagged.status).toBe(200);
    expect((await json<ComplimentItem>(tagged)).evidenceStatementIds).toHaveLength(2);
    const wf = await asDemoTenant(
      async (c) =>
        (await c.query("SELECT 1 FROM workflow_instance WHERE subject_id = $1", [created.id])).rows,
    );
    expect(wf).toEqual([]);
    expect((await as("carer", "/v1/compliments")).status).toBe(403);
  });
});
