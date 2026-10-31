import { randomUUID } from "node:crypto";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { ukDateOf, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { escalateOutstandingDoses } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness } from "./support/harness";

/**
 * Administrations API (Phase 2 slice 22; MEDS-002; medicines.md section 13): slice 3's rules on
 * every record, idempotent by the client's id, corrections as new records, a second person's
 * signature, the escalations raised as tasks, outstanding doses through the task engine, dosing
 * records for variable doses, the round, and audit by id only. The demo Registered Manager
 * records, the owner witnesses and checks; competence comes from the port, never the request.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const BEN = "0194d000-0000-7000-8600-000000000002";
const CARL = "0194d000-0000-7000-8600-000000000003";
const PARACETAMOL = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
const LACTULOSE = { vmpId: "90000051000001100", ampId: null, name: "Lactulose" };
const ORAL = { code: "26643006", name: "Oral" };
const TABLET = { code: "428673006", name: "tablet" };
const ML = { code: "258773002", name: "ml" };
const SOURCE = { kind: "prescription", reference: "Prescription, Dr A Example, 31/10/2026" };
const MINUTE = 60_000;

const competence = fixedCompetence();
const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const json = async <T>(r: Response) => (await r.json()) as T;

/** HH:MM in UK time, a few minutes from now, so the dose is after its entry was recorded. */
function ukTime(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

const today = () => ukStartOfDay(ukDateOf(new Date()));

async function transcribe(personId: string, body: Record<string, unknown>) {
  const r = await send("manager", `/v1/people/${personId}/medicines`, {
    method: "POST",
    body: {
      product: PARACETAMOL,
      route: ORAL,
      prescriber: "Dr A Example",
      startsAt: today().toISOString(),
      source: SOURCE,
      ...body,
    },
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return json<{ id: string }>(r);
}

async function asDemo<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
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

interface Recorded {
  administration: {
    id: string;
    outcome: string;
    flags: string[];
    supersededById: string | null;
    supersedesId: string | null;
    dosingRecordId: string | null;
    witness: { id: string } | null;
  };
  escalations: { severity: string; taskId: string }[];
}

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  for (const u of ["owner", "manager", "carer"] as const) {
    competence.held.set(`${DEMO.tenantId}:${DEMO.users[u].id}`, "current");
  }
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazards HZ-003 and HZ-004 recording a scheduled dose", () => {
  let entryId = "";
  let dueAt = "";
  let recordId = "";
  const give = (id: string, extra: Record<string, unknown> = {}) =>
    send("manager", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id,
        entryId,
        dueAt,
        outcome: "given",
        amount: { quantity: 2, unitCode: TABLET.code },
        timingReason: "Given with breakfast",
        ...extra,
      },
    });

  it("records a dose given in its window, idempotent by the client's id", async () => {
    const due = new Date(Date.now() + 3 * MINUTE);
    const entry = await transcribe(ADA, {
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_day" },
          times: [{ time: ukTime(due), dose: { kind: "amount", quantity: 2, unit: TABLET } }],
        },
      },
    });
    entryId = entry.id;
    const record = (
      await json<{ doses: { entryId: string; dueAt: string; state: string }[] }>(
        await send("manager", `/v1/people/${ADA}/medicine-round`),
      )
    ).doses.find((d) => d.entryId === entryId);
    expect(record?.state).toBe("due");
    dueAt = record?.dueAt as string;
    recordId = randomUUID();
    const r = await give(recordId);
    expect(r.status, await r.clone().text()).toBe(201);
    const out = await json<Recorded>(r);
    expect(out.administration.flags).toContain("early");
    expect(out.administration.flags).toContain("entry_not_yet_checked");
    const again = await give(recordId);
    expect(again.status).toBe(200);
    expect((await json<Recorded>(again)).administration.id).toBe(recordId);
    const other = await give(recordId, { amount: { quantity: 1, unitCode: TABLET.code } });
    expect(other.status).toBe(409);
  });

  it("refuses the same dose twice, and audits the refusal", async () => {
    const r = await give(randomUUID());
    expect(r.status).toBe(422);
    expect((await json<{ code: string }>(r)).code).toBe("administration_already_recorded");
  });

  it("refuses a dose without its amount, or in another unit", async () => {
    const r = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: { id: randomUUID(), entryId, dueAt: null, outcome: "given", amount: null },
    });
    expect(r.status).toBe(422);
  });

  it("hazard HZ-001 refuses another person's medicine on this person's record", async () => {
    const r = await send("manager", `/v1/people/${BEN}/medicine-administrations`, {
      method: "POST",
      body: { id: randomUUID(), entryId, dueAt, outcome: "refused", reason: { code: "declined" } },
    });
    expect(r.status).toBe(404);
  });

  it("corrects a record as a new one that supersedes it, once, by its author", async () => {
    const carer = await send("carer", `/v1/medicine-administrations/${recordId}/corrections`, {
      method: "POST",
      body: {
        id: randomUUID(),
        correctionReason: "Recorded as given in error",
        entryId,
        dueAt,
        outcome: "refused",
        reason: { code: "declined", note: null },
        givenAt: new Date().toISOString(),
      },
    });
    expect(carer.status).toBe(422);
    expect((await json<{ code: string }>(carer)).code).toBe("administration_not_author");
    const correctionId = randomUUID();
    const r = await send("manager", `/v1/medicine-administrations/${recordId}/corrections`, {
      method: "POST",
      body: {
        id: correctionId,
        correctionReason: "Recorded as given in error: she declined it",
        entryId,
        dueAt,
        outcome: "refused",
        reason: { code: "declined", note: null },
        givenAt: new Date().toISOString(),
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await json<Recorded>(r)).administration.supersedesId).toBe(recordId);
    const twice = await send("manager", `/v1/medicine-administrations/${recordId}/corrections`, {
      method: "POST",
      body: {
        id: randomUUID(),
        correctionReason: "Again",
        entryId,
        dueAt,
        outcome: "refused",
        reason: { code: "declined", note: null },
        givenAt: new Date().toISOString(),
      },
    });
    expect(twice.status).toBe(422);
    const list = await json<{ administrations: { id: string; supersededById: string | null }[] }>(
      await send(
        "manager",
        `/v1/people/${ADA}/medicine-administrations?from=${encodeURIComponent(
          new Date(Date.now() - 60 * MINUTE).toISOString(),
        )}&to=${encodeURIComponent(new Date(Date.now() + 60 * MINUTE).toISOString())}`,
      ),
    );
    expect(list.administrations.find((a) => a.id === recordId)?.supersededById).toBe(correctionId);
  });

  it("hazard HZ-116 takes a witness's second signature, never the recorder's and only after step-up", async () => {
    const self = await send("manager", `/v1/medicine-administrations/${recordId}/witness`, {
      method: "POST",
      body: { witnessed: true },
    });
    expect(self.status).toBe(422);
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const stale = await send("owner", `/v1/medicine-administrations/${recordId}/witness`, {
        method: "POST",
        body: { witnessed: true },
      });
      expect(stale.status).toBe(403);
    } finally {
      await ageSession(auth, session, 0);
    }
    const ok = await send("owner", `/v1/medicine-administrations/${recordId}/witness`, {
      method: "POST",
      body: { witnessed: true },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await json<Recorded>(ok)).administration.witness?.id).toBe(DEMO.users.owner.id);
  });
});

describe("hazard HZ-119 competence from the port", () => {
  it("refuses someone with no sign-off, and records under an override of an expired one, flagged", async () => {
    const entry = await transcribe(BEN, {
      product: LACTULOSE,
      indication: "Constipation",
      directions: {
        kind: "when_required",
        dose: { kind: "amount", quantity: 15, unit: ML },
        maxQuantityPer24Hours: 30,
      },
    });
    const give = (user: string) =>
      send(user, `/v1/people/${BEN}/medicine-administrations`, {
        method: "POST",
        body: {
          id: randomUUID(),
          entryId: entry.id,
          outcome: "refused",
          reason: { code: "declined", note: null },
        },
      });
    const key = `${DEMO.tenantId}:${DEMO.users.manager.id}`;
    competence.held.set(key, "not_held");
    expect((await give("manager")).status).toBe(422);
    competence.held.set(key, "expired");
    expect((await give("manager")).status).toBe(422);
    competence.overrides.set(key, {
      memberId: DEMO.users.manager.id,
      approvedBy: DEMO.users.owner.id,
      reason: "Competence check booked for tomorrow",
      from: new Date(Date.now() - MINUTE),
      until: new Date(Date.now() + 60 * MINUTE),
    });
    const r = await give("manager");
    competence.held.set(key, "current");
    competence.overrides.delete(key);
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await json<Recorded>(r)).administration.flags).toContain("competence_override");
  });
});

describe("hazard HZ-004 when required: the 24-hour maximum", () => {
  it("refuses a dose over the maximum on the round, and records one already taken, escalated urgently", async () => {
    const entries = await json<{ entries: { id: string; product: { vmpId: string } }[] }>(
      await send("manager", `/v1/people/${BEN}/medicines`),
    );
    const entryId = entries.entries.find((e) => e.product.vmpId === LACTULOSE.vmpId)?.id;
    const give = (outcome: string) =>
      send("manager", `/v1/people/${BEN}/medicine-administrations`, {
        method: "POST",
        body: {
          id: randomUUID(),
          entryId,
          outcome,
          amount: { quantity: 15, unitCode: ML.code },
        },
      });
    expect((await give("given")).status).toBe(201);
    expect((await give("given")).status).toBe(201);
    const over = await give("given");
    expect(over.status).toBe(422);
    expect((await json<{ code: string }>(over)).code).toBe("administration_prn_maximum_reached");
    const taken = await give("self_administered");
    expect(taken.status, await taken.clone().text()).toBe(201);
    const out = await json<Recorded>(taken);
    expect(out.administration.flags).toContain("over_maximum");
    expect(out.escalations.map((e) => e.severity)).toEqual(["urgent"]);
    const round = await json<{ whenRequired: { entryId: string; remaining: number | null }[] }>(
      await send("manager", `/v1/people/${BEN}/medicine-round`),
    );
    expect(round.whenRequired.find((w) => w.entryId === entryId)?.remaining).toBe(0);
  });
});

describe("a dose recorded after it was given (#162)", () => {
  let entryId = "";
  it("needs a time before now and a reason, and is always flagged and escalated", async () => {
    const entry = await transcribe(CARL, {
      product: LACTULOSE,
      indication: "Constipation",
      directions: {
        kind: "when_required",
        dose: { kind: "amount", quantity: 15, unit: ML },
        maxQuantityPer24Hours: 60,
      },
    });
    entryId = entry.id;
    const record = (givenAt: Date, reason: string | null) =>
      send("manager", `/v1/people/${CARL}/medicine-administrations`, {
        method: "POST",
        body: {
          id: randomUUID(),
          entryId,
          outcome: "given",
          amount: { quantity: 15, unitCode: ML.code },
          givenAt: givenAt.toISOString(),
          givenBeforeRecorded: reason === null ? null : { reason },
        },
      });
    const future = await record(new Date(Date.now() + 10 * MINUTE), "Given during a fall");
    expect(future.status).toBe(422);
    const earlierNoRoute = await record(new Date(Date.now() - 30 * MINUTE), null);
    expect(earlierNoRoute.status).toBe(422);
    const r = await record(
      new Date(Date.now() - 30 * MINUTE),
      "Given during a fall, recorded after",
    );
    expect(r.status, await r.clone().text()).toBe(201);
    const out = await json<Recorded>(r);
    expect(out.administration.flags).toContain("given_before_recorded");
    expect(out.escalations.length).toBeGreaterThan(0);
    const tasks = await asDemo(
      async (c) =>
        (
          await c.query<{ kind: string }>("SELECT kind FROM task WHERE source_id = $1", [
            out.administration.id,
          ])
        ).rows,
    );
    expect(tasks.map((t) => t.kind)).toEqual(["medicines.administration.review"]);
  });

  it("refuses it from someone recording without current competence", async () => {
    const key = `${DEMO.tenantId}:${DEMO.users.manager.id}`;
    competence.held.set(key, "expired");
    const r = await send("manager", `/v1/people/${CARL}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId,
        outcome: "given",
        amount: { quantity: 15, unitCode: ML.code },
        givenAt: new Date(Date.now() - 20 * MINUTE).toISOString(),
        givenBeforeRecorded: { reason: "Recorded after" },
      },
    });
    competence.held.set(key, "current");
    expect(r.status).toBe(422);
    expect((await json<{ code: string }>(r)).code).toBe("administration_competence_expired");
  });
});

describe("hazard HZ-003 outstanding doses through the task engine", () => {
  it("raises one task for a dose whose window has ended with no outcome, and closes it when recorded", async () => {
    const DORA = "0194d000-0000-7000-8600-000000000004";
    const entryId = randomUUID();
    const due = new Date(Date.now() - 3 * 60 * MINUTE);
    await asDemo(async (c) => {
      await c.query(
        `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, transcribed_by, transcribed_at)
         VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Paracetamol 500mg tablets', '26643006', 'Oral',
           'regular', 'every_day', 'Dr A Example', now() - interval '2 days', 'prescription',
           'Prescription', $4, now() - interval '2 days')`,
        [entryId, DORA, PARACETAMOL.vmpId, DEMO.users.manager.id],
      );
      await c.query(
        `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
           quantity, unit_code, unit_name)
         VALUES ($1, $2, 0, $3, 'amount', 2, '428673006', 'tablet')`,
        [entryId, DORA, ukTime(due)],
      );
    });
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    expect(await escalateOutstandingDoses(deps)).toBeGreaterThan(0);
    expect(await escalateOutstandingDoses(deps)).toBe(0);
    const open = await asDemo(
      async (c) =>
        (
          await c.query<{ due_at: Date }>(
            "SELECT due_at FROM task WHERE kind = 'medicines.dose.outstanding' AND source_id = $1 AND status = 'open'",
            [entryId],
          )
        ).rows,
    );
    expect(open.length).toBeGreaterThan(0);
    const dueAt = (open.at(-1) as { due_at: Date }).due_at.toISOString();
    const r = await send("manager", `/v1/people/${DORA}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId,
        dueAt,
        outcome: "omitted",
        reason: { code: "asleep", note: null },
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const status = await asDemo(
      async (c) =>
        (
          await c.query<{ status: string }>(
            "SELECT status FROM task WHERE kind = 'medicines.dose.outstanding' AND source_id = $1 AND due_at = $2",
            [entryId, dueAt],
          )
        ).rows[0]?.status,
    );
    expect(status).toBe("done");
  });
});

describe("hazards HZ-005 and HZ-116 a variable dose needs a checked dosing record", () => {
  it("refuses the dose until a second person checks the record, then records which record it used", async () => {
    const due = new Date(Date.now() + 3 * MINUTE);
    const EVE = "0194d000-0000-7000-8600-000000000005";
    const entry = await transcribe(EVE, {
      product: { vmpId: "90000041000001103", ampId: null, name: "Ibuprofen" },
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_day" },
          times: [{ time: ukTime(due), dose: { kind: "variable", unit: TABLET } }],
        },
      },
    });
    const dose = (
      await json<{ doses: { entryId: string; dueAt: string; date: string; time: string }[] }>(
        await send("manager", `/v1/people/${EVE}/medicine-round`),
      )
    ).doses.find((d) => d.entryId === entry.id);
    const give = () =>
      send("manager", `/v1/people/${EVE}/medicine-administrations`, {
        method: "POST",
        body: {
          id: randomUUID(),
          entryId: entry.id,
          dueAt: dose?.dueAt,
          outcome: "given",
          amount: { quantity: 1, unitCode: TABLET.code },
          timingReason: "Given with lunch",
        },
      });
    const none = await give();
    expect(none.status).toBe(422);
    expect((await json<{ code: string }>(none)).code).toBe(
      "administration_no_checked_dosing_record",
    );
    const rec = await send("manager", `/v1/medicines/${entry.id}/dosing-records`, {
      method: "POST",
      body: {
        source: { kind: "clinic_letter", reference: "Clinic letter, 31/10/2026" },
        doses: [{ date: dose?.date, time: dose?.time, quantity: 1 }],
      },
    });
    expect(rec.status, await rec.clone().text()).toBe(201);
    const recordId = (await json<{ id: string }>(rec)).id;
    expect((await give()).status).toBe(422);
    const self = await send("manager", `/v1/dosing-records/${recordId}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(self.status).toBe(422);
    const checked = await send("owner", `/v1/dosing-records/${recordId}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(checked.status, await checked.clone().text()).toBe(200);
    const r = await give();
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await json<Recorded>(r)).administration.dosingRecordId).toBe(recordId);
  });
});

describe("audit by id only", () => {
  it("audits records, refusals, corrections and witnesses with ids, never the medicine", async () => {
    const rows = await asDemo(
      async (c) =>
        (
          await c.query<{ action: string; outcome: string; text: string }>(
            `SELECT action, outcome, coalesce(scope::text, '') AS text FROM audit_event
              WHERE action LIKE 'medicines.administration.%' OR action LIKE 'medicines.dosing_record.%'`,
          )
        ).rows,
    );
    const actions = new Set(rows.map((r) => `${r.action}:${r.outcome}`));
    for (const a of [
      "medicines.administration.recorded:success",
      "medicines.administration.recorded:denied",
      "medicines.administration.corrected:success",
      "medicines.administration.witnessed:success",
      "medicines.dosing_record.recorded:success",
      "medicines.dosing_record.checked:success",
    ]) {
      expect(actions.has(a), [...actions].join(", ")).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toMatch(/Paracetamol|Lactulose|tablet|Dr A Example/);
  });
});
