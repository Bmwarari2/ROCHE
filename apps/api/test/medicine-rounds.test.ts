import { randomUUID } from "node:crypto";
import { DEVICE_HEADER } from "@harbour/contracts";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { ukDateOf, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { escalateOutstandingDoses, outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * Rounds, escalation and conflict review (Phase 2 slice 48; MEDS-002; medicines.md section 15):
 * the round for a location with time-critical doses first and when-required medicines with when
 * last given; a second record of a dose uploaded from a device kept as a conflict, never dropped,
 * reviewed once by the nurse in charge; outstanding doses escalated as tasks that reach the shift
 * handover.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const BEN = "0194d000-0000-7000-8600-000000000002";
const CARL = "0194d000-0000-7000-8600-000000000003";
const PARACETAMOL = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
const IBUPROFEN = { vmpId: "90000041000001103", ampId: null, name: "Ibuprofen 200mg tablets" };
const LACTULOSE = { vmpId: "90000051000001100", ampId: null, name: "Lactulose" };
const ORAL = { code: "26643006", name: "Oral" };
const TABLET = { code: "428673006", name: "tablet" };
const ML = { code: "258773002", name: "ml" };
const SOURCE = { kind: "prescription", reference: "Prescription, Dr A Example, 31/10/2026" };
const MINUTE = 60_000;
const competence = fixedCompetence();
const DEVICE = "0194d000-0000-7000-8600-0000000000de";
const send = (
  user: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const json = async <T>(r: Response) => (await r.json()) as T;

function ukTime(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
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

async function transcribe(personId: string, body: Record<string, unknown>) {
  const r = await send("manager", `/v1/people/${personId}/medicines`, {
    method: "POST",
    body: {
      product: PARACETAMOL,
      route: ORAL,
      prescriber: "Dr A Example",
      startsAt: ukStartOfDay(ukDateOf(new Date())).toISOString(),
      source: SOURCE,
      ...body,
    },
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return json<{ id: string }>(r);
}

const regularAt = (time: string) => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "every_day" },
    times: [{ time, dose: { kind: "amount", quantity: 1, unit: TABLET } }],
  },
});

const slot = () =>
  `from=${encodeURIComponent(new Date(Date.now() - 60 * MINUTE).toISOString())}&to=${encodeURIComponent(
    new Date(Date.now() + 60 * MINUTE).toISOString(),
  )}`;

interface Round {
  people: {
    personId: string;
    doses: { entryId: string; dueAt: string; timeCritical: boolean; stateInWords: string }[];
    whenRequired: { entryId: string; lastGiven: { by: string } | null }[];
  }[];
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

describe("hazards HZ-001 and HZ-003 the round for a location", () => {
  let critical = "";
  let routine = "";
  let prn = "";

  it("lists each person's doses in the slot, time-critical first, with when-required medicines and when last given", async () => {
    const soon = ukTime(new Date(Date.now() + 3 * MINUTE));
    routine = (await transcribe(ADA, { directions: regularAt(soon) })).id;
    critical = (
      await transcribe(ADA, {
        product: IBUPROFEN,
        tags: ["time_critical"],
        directions: regularAt(ukTime(new Date(Date.now() + 20 * MINUTE))),
      })
    ).id;
    prn = (
      await transcribe(BEN, {
        product: LACTULOSE,
        indication: "Constipation",
        directions: {
          kind: "when_required",
          dose: { kind: "amount", quantity: 15, unit: ML },
          maxQuantityPer24Hours: 30,
        },
      })
    ).id;
    const given = await send("manager", `/v1/people/${BEN}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId: prn,
        outcome: "given",
        amount: { quantity: 15, unitCode: ML.code },
      },
    });
    expect(given.status, await given.clone().text()).toBe(201);
    const r = await send("manager", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`);
    expect(r.status, await r.clone().text()).toBe(200);
    const round = await json<Round>(r);
    const ada = round.people.find((p) => p.personId === ADA);
    expect(ada?.doses.map((d) => d.entryId)).toEqual([critical, routine]);
    expect(ada?.doses.every((d) => d.stateInWords.length > 0)).toBe(true);
    const ben = round.people.find((p) => p.personId === BEN);
    expect(ben?.whenRequired.find((w) => w.entryId === prn)?.lastGiven?.by).toBe(
      DEMO.users.manager.id,
    );
  });

  it("refuses a slot longer than 12 hours, and someone who does not give medicines", async () => {
    const long = await send(
      "manager",
      `/v1/locations/${DEMO.locationId}/medicine-round?from=2026-11-01T00:00:00Z&to=2026-11-01T13:00:00Z`,
    );
    expect(long.status).toBe(422);
    expect(
      (await send("quality", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`)).status,
    ).toBe(403);
  });

  it("hazard HZ-004 keeps a device's second record of a dose as a conflict for review, never dropping it", async () => {
    const round = await json<Round>(
      await send("manager", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`),
    );
    const dose = round.people
      .find((p) => p.personId === ADA)
      ?.doses.find((d) => d.entryId === critical);
    const record = (id: string, device: boolean, entryId = critical) =>
      send("manager", `/v1/people/${ADA}/medicine-administrations`, {
        method: "POST",
        headers: device ? { [DEVICE_HEADER]: DEVICE } : {},
        body: {
          id,
          entryId,
          dueAt: dose?.dueAt,
          outcome: "given",
          amount: { quantity: 1, unitCode: TABLET.code },
          timingReason: "Given with breakfast",
          deviceOffsetMs: device ? 0 : null,
        },
      });
    const first = await record(randomUUID(), false);
    expect(first.status, await first.clone().text()).toBe(201);
    const standingId = (await json<{ administration: { id: string } }>(first)).administration.id;
    // On the web (no bound device) a second record is refused in words: the person sees it.
    expect((await record(randomUUID(), false)).status).toBe(422);
    // From a device it is kept, and a resend finds the same conflict.
    const secondId = randomUUID();
    const second = await record(secondId, true);
    expect(second.status, await second.clone().text()).toBe(202);
    const raised = await json<{ conflictId: string; standingId: string }>(second);
    expect(raised.standingId).toBe(standingId);
    const again = await record(secondId, true);
    expect(again.status).toBe(202);
    expect((await json<{ conflictId: string }>(again)).conflictId).toBe(raised.conflictId);
    // The same id sent for another dose is refused, not matched to the conflict (security L4).
    expect((await record(secondId, true, routine)).status).toBe(409);
    // A further upload of the dose by the same person joins the open conflict (security H1).
    const third = await record(randomUUID(), true);
    expect(third.status).toBe(202);
    expect((await json<{ conflictId: string }>(third)).conflictId).toBe(raised.conflictId);
    // The list needs a location or a person.
    expect((await send("manager", "/v1/medicine-administration-conflicts")).status).toBe(422);
    const tasks = await asDemo(
      async (c) =>
        (
          await c.query<{ priority: string; status: string }>(
            "SELECT priority, status FROM task WHERE kind = 'medicines.administration.conflict' AND source_id = $1",
            [raised.conflictId],
          )
        ).rows,
    );
    expect(tasks).toEqual([{ priority: "urgent", status: "open" }]);

    const list = await json<{
      conflicts: {
        id: string;
        standing: { id: string };
        uploaded: { id: string };
        problems: string[];
      }[];
    }>(
      await send("manager", `/v1/medicine-administration-conflicts?locationId=${DEMO.locationId}`),
    );
    const shown = list.conflicts.find((x) => x.id === raised.conflictId);
    expect(shown?.standing.id).toBe(standingId);
    expect(shown?.uploaded.id).toBe(secondId);
    expect(shown?.problems.length).toBeGreaterThan(0);

    const resolve = (body: Record<string, unknown>, who = "manager") =>
      send(who, `/v1/medicine-administration-conflicts/${raised.conflictId}/resolve`, {
        method: "POST",
        body,
      });
    expect(
      (await resolve({ outcome: "first_stands", note: "Same dose sent twice" }, "carer")).status,
    ).toBe(403);
    expect(
      (await resolve({ outcome: "corrected", correctionId: randomUUID(), note: "Corrected" }))
        .status,
    ).toBe(422);
    const ok = await resolve({
      outcome: "first_stands",
      note: "The same dose, recorded on two tablets",
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await json<{ resolution: { outcome: string } }>(ok)).resolution.outcome).toBe(
      "first_stands",
    );
    expect((await resolve({ outcome: "first_stands", note: "Again" })).status).toBe(409);
    const done = await asDemo(
      async (c) =>
        (
          await c.query<{ status: string }>(
            "SELECT status FROM task WHERE kind = 'medicines.administration.conflict' AND source_id = $1",
            [raised.conflictId],
          )
        ).rows[0]?.status,
    );
    expect(done).toBe("done");

    // Once resolved, a later upload opens a new conflict; found given twice, it raises an incident.
    const fourth = await record(randomUUID(), true);
    expect(fourth.status, await fourth.clone().text()).toBe(202);
    const next = await json<{ conflictId: string }>(fourth);
    expect(next.conflictId).not.toBe(raised.conflictId);
    const twice = await send(
      "manager",
      `/v1/medicine-administration-conflicts/${next.conflictId}/resolve`,
      {
        method: "POST",
        body: { outcome: "both_given", correctionId: randomUUID(), note: "Given twice" },
      },
    );
    expect(twice.status).toBe(422);
    const both = await send(
      "manager",
      `/v1/medicine-administration-conflicts/${next.conflictId}/resolve`,
      { method: "POST", body: { outcome: "both_given", note: "Given on both tablets" } },
    );
    expect(both.status, await both.clone().text()).toBe(200);
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    while ((await relayOutbox(deps, outboxHandlers(deps))) > 0) {
      // Drain the outbox.
    }
    const incidents = await asDemo(
      async (c) =>
        (
          await c.query<{ type: string; person_ids: string[] }>(
            "SELECT type, person_ids FROM incident WHERE id = $1",
            [next.conflictId],
          )
        ).rows,
    );
    expect(incidents).toEqual([{ type: "medication", person_ids: [ADA] }]);
  });
});

describe("hazards HZ-003 and HZ-008 an outstanding dose is escalated and reaches the handover", () => {
  it("raises a task for a dose with no outcome after its window, and the shift handover carries it", async () => {
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
        [entryId, CARL, PARACETAMOL.vmpId, DEMO.users.manager.id],
      );
      await c.query(
        `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
           quantity, unit_code, unit_name)
         VALUES ($1, $2, 0, $3, 'amount', 2, '428673006', 'tablet')`,
        [entryId, CARL, ukTime(due)],
      );
    });
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    expect(await escalateOutstandingDoses(deps)).toBeGreaterThan(0);
    const [t] = await asDemo(
      async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM task WHERE kind = 'medicines.dose.outstanding' AND source_id = $1 ORDER BY due_at DESC LIMIT 1",
            [entryId],
          )
        ).rows,
    );
    const compiled = await send("manager", `/v1/locations/${DEMO.locationId}/handovers`, {
      method: "POST",
      body: {},
    });
    expect([200, 201]).toContain(compiled.status);
    const handover = await json<{
      items: { sourceId: string; kind: string; personId: string | null }[];
    }>(compiled);
    const item = handover.items.find((i) => i.sourceId === t?.id);
    expect(item?.personId).toBe(CARL);
    expect(["overdue_task", "unfinished_task"]).toContain(item?.kind);
  });
});
