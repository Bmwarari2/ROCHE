import { randomUUID } from "node:crypto";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { withAdminClient } from "@harbour/db/testing";
import { TEMPERATURE_TASK_TITLE, ukDateOf, ukIsoDate, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { escalateTasks, promptMedicineOrders } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * Medicines stock, ordering, disposal and temperatures through the API (medicines.md section 15;
 * MEDS-008; slice 42; HZ-132, HZ-003): receipts, counts and disposals; slice 22's hook moving
 * stock on a given dose and its correction; "not available: out of stock" raising a task; a
 * controlled drug left to its register; a reorder prompt once; an order through the pharmacy mock
 * and filled by receipts; a temperature out of range raising an urgent task that escalates when
 * overdue, with words that give no advice on whether the medicines can be used. All the people
 * here are invented.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const BEN = "0194d000-0000-7000-8600-000000000002";
const PARACETAMOL = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
const ORAL = { code: "26643006", name: "Oral" };
const TABLET = { code: "428673006", name: "tablet" };
const SOURCE = { kind: "prescription", reference: "Prescription, Dr A Example, 31/10/2026" };
const MINUTE = 60_000;
const competence = fixedCompetence();

const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const post = (user: string, path: string, body: unknown) =>
  send(user, path, { method: "POST", body });
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

/** A regular paracetamol entry due a few minutes from now, and the dose's time. */
async function entryDueSoon(
  personId: string,
  product: typeof PARACETAMOL = PARACETAMOL,
): Promise<{ entryId: string; dueAt: string }> {
  const due = new Date(Date.now() + 3 * MINUTE);
  const r = await post("manager", `/v1/people/${personId}/medicines`, {
    product,
    route: ORAL,
    prescriber: "Dr A Example",
    startsAt: ukStartOfDay(ukDateOf(new Date())).toISOString(),
    source: SOURCE,
    directions: {
      kind: "regular",
      schedule: {
        pattern: { kind: "every_day" },
        times: [{ time: ukTime(due), dose: { kind: "amount", quantity: 2, unit: TABLET } }],
      },
    },
  });
  expect(r.status, await r.clone().text()).toBe(201);
  const entryId = (await json<{ id: string }>(r)).id;
  const round = await json<{ doses: { entryId: string; dueAt: string }[] }>(
    await send("manager", `/v1/people/${personId}/medicine-round`),
  );
  return { entryId, dueAt: round.doses.find((d) => d.entryId === entryId)?.dueAt as string };
}

type Stock = { item: { id: string; balance: number; movements: { movement: string }[] } };
const balance = async (personId: string, itemId: string) =>
  (
    await json<{ items: { id: string; balance: number }[] }>(
      await send("manager", `/v1/people/${personId}/medicine-stock`),
    )
  ).items.find((i) => i.id === itemId)?.balance;

let ITEM = "";
let ENTRY = "";
let DUE = "";
let RECORD = "";

beforeAll(async () => {
  h = await createHarness({ PHARMACY_ORDERS: "mock" });
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  for (const u of ["owner", "manager", "carer"] as const) {
    competence.held.set(`${DEMO.tenantId}:${DEMO.users[u].id}`, "current");
  }
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-003 MEDS-008 a person's stock and slice 22's hook", () => {
  it("opens an item, receives stock and moves it when a dose is given and corrected", async () => {
    ({ entryId: ENTRY, dueAt: DUE } = await entryDueSoon(ADA));
    const opened = await post("manager", `/v1/people/${ADA}/medicine-stock`, {
      medicationId: ENTRY,
    });
    expect(opened.status, await opened.clone().text()).toBe(201);
    ITEM = (await json<Stock>(opened)).item.id;
    expect(
      (await post("carer", `/v1/medicine-stock/${ITEM}/receipts`, { quantity: 28 })).status,
    ).toBe(403);
    expect(
      (await post("manager", `/v1/medicine-stock/${ITEM}/receipts`, { quantity: 28 })).status,
    ).toBe(201);
    RECORD = randomUUID();
    const given = await post("manager", `/v1/people/${ADA}/medicine-administrations`, {
      id: RECORD,
      entryId: ENTRY,
      dueAt: DUE,
      outcome: "given",
      amount: { quantity: 2, unitCode: TABLET.code },
      timingReason: "Given with breakfast",
    });
    expect(given.status, await given.clone().text()).toBe(201);
    expect(await balance(ADA, ITEM)).toBe(26);
    const corrected = await post("manager", `/v1/medicine-administrations/${RECORD}/corrections`, {
      id: randomUUID(),
      correctionReason: "Recorded against the wrong person's dose",
      entryId: ENTRY,
      dueAt: DUE,
      outcome: "refused",
      reason: { code: "declined", note: null },
      givenAt: new Date().toISOString(),
    });
    expect(corrected.status, await corrected.clone().text()).toBe(201);
    expect(await balance(ADA, ITEM)).toBe(28);
  });

  it("adjusts a count that differs, with a reason, and never one that matches", async () => {
    expect(
      (await post("manager", `/v1/medicine-stock/${ITEM}/counts`, { counted: 28 })).status,
    ).toBe(200);
    expect(
      (await post("manager", `/v1/medicine-stock/${ITEM}/counts`, { counted: 27 })).status,
    ).toBe(422);
    const r = await post("manager", `/v1/medicine-stock/${ITEM}/counts`, {
      counted: 27,
      reason: "One tablet found damaged in the pack",
    });
    expect(r.status).toBe(200);
    expect((await json<Stock>(r)).item.movements[0]?.movement).toBe("count_adjustment");
  });

  it("raises a task when a dose is not available because it is out of stock", async () => {
    const ben = await entryDueSoon(BEN);
    const r = await post("manager", `/v1/people/${BEN}/medicine-administrations`, {
      id: randomUUID(),
      entryId: ben.entryId,
      dueAt: ben.dueAt,
      outcome: "not_available",
      reason: { code: "out_of_stock", note: null },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const tasks = await asDemo((c) =>
      c.query(
        "SELECT priority FROM task WHERE kind = 'medicines.stock.out_of_stock' AND person_id = $1",
        [BEN],
      ),
    );
    expect(tasks.rows).toEqual([{ priority: "urgent" }]);
  });

  it("leaves a controlled drug to its register", async () => {
    const cd = await entryDueSoon(BEN, {
      vmpId: "90000041000001103",
      ampId: null,
      name: "Ibuprofen 200mg tablets",
    });
    // Test setup only: dm+d's schedule, set past the record's guard (slice 10 sets it in life).
    await withAdminClient(async (c) => {
      await c.query("SET session_replication_role = replica");
      await c.query("UPDATE medication SET cd_schedule = '2' WHERE id = $1", [cd.entryId]);
    }, h.db.name);
    const r = await post("manager", `/v1/people/${BEN}/medicine-stock`, {
      medicationId: cd.entryId,
    });
    expect(r.status).toBe(422);
    expect((await json<{ code: string }>(r)).code).toBe("controlled_drug_register");
  });
});

describe("hazard HZ-002 MEDS-008 disposal witnessed per the organisation's policy", () => {
  it("needs a second member, who confirms it themselves, once", async () => {
    const path = `/v1/medicine-stock/${ITEM}/disposals`;
    const alone = await post("manager", path, {
      quantity: 1,
      reason: "dropped_or_spoilt",
      noWitnessReason: "Only one of us on shift tonight",
    });
    expect(alone.status).toBe(422);
    expect(
      (
        await post("manager", path, {
          quantity: 1,
          reason: "dropped_or_spoilt",
          witnessId: DEMO.users.manager.id,
        })
      ).status,
    ).toBe(422);
    const r = await post("manager", path, {
      quantity: 1,
      reason: "dropped_or_spoilt",
      witnessId: DEMO.users.carer.id,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const disposal = (await json<{ disposal: { id: string; status: string } }>(r)).disposal;
    expect(disposal.status).toBe("awaiting_witness");
    expect(await balance(ADA, ITEM)).toBe(26);
    expect(
      (await post("manager", `/v1/medicine-disposals/${disposal.id}/witness`, {})).status,
    ).toBe(403);
    const witnessed = await post("carer", `/v1/medicine-disposals/${disposal.id}/witness`, {});
    expect(witnessed.status).toBe(200);
    expect((await json<{ status: string }>(witnessed)).status).toBe("witnessed");
    expect((await post("carer", `/v1/medicine-disposals/${disposal.id}/witness`, {})).status).toBe(
      403,
    );
  });
});

describe("MEDS-008 the 28-day cycle, reorder prompts and orders", () => {
  it("prompts once before the cycle, then an order through the pharmacy mock is filled by receipts", async () => {
    const location = await asDemo(
      async (c) =>
        (
          await c.query<{ location_id: string }>("SELECT location_id FROM person WHERE id = $1", [
            ADA,
          ])
        ).rows[0]?.location_id as string,
    );
    const anchor = ukIsoDate(new Date(Date.now() + 3 * 86_400_000));
    const set = await send("manager", `/v1/locations/${location}/medicine-cycle`, {
      method: "PUT",
      body: { anchorOn: anchor, version: null },
    });
    expect(set.status, await set.clone().text()).toBe(200);
    expect((await json<{ nextCycleStartsOn: string }>(set)).nextCycleStartsOn).toBe(anchor);
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    expect(await promptMedicineOrders(deps)).toBe(1);
    expect(await promptMedicineOrders(deps)).toBe(0);
    const made = await post("manager", `/v1/locations/${location}/medicine-orders`, {
      cycleStartsOn: anchor,
      lines: [{ personId: ADA, medicationId: ENTRY, quantity: 56 }],
    });
    expect(made.status, await made.clone().text()).toBe(201);
    const order = await json<{ id: string; version: number; lines: { id: string }[] }>(made);
    const submitted = await post("manager", `/v1/medicine-orders/${order.id}/submit`, {
      version: order.version,
      via: "pharmacy_port",
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    expect((await json<{ pharmacyReference: string }>(submitted)).pharmacyReference).toBe(
      "mock-order-1",
    );
    const sent = h.handle.pharmacyMock.received[0];
    expect(sent?.lines[0]).toMatchObject({
      personRef: ADA,
      vmpId: PARACETAMOL.vmpId,
      quantity: 56,
    });
    expect(JSON.stringify(sent)).not.toMatch(/Example|Ada/);
    await post("manager", `/v1/medicine-stock/${ITEM}/receipts`, {
      quantity: 28,
      orderLineId: order.lines[0]?.id,
    });
    expect(
      (await json<{ status: string }>(await send("manager", `/v1/medicine-orders/${order.id}`)))
        .status,
    ).toBe("part_received");
    await post("manager", `/v1/medicine-stock/${ITEM}/receipts`, {
      quantity: 28,
      orderLineId: order.lines[0]?.id,
    });
    expect(
      (await json<{ status: string }>(await send("manager", `/v1/medicine-orders/${order.id}`)))
        .status,
    ).toBe("received");
  });
});

describe("hazard HZ-132 MEDS-008 storage temperatures", () => {
  it("raises an urgent task for an out-of-range reading, which escalates when overdue, and never advises on use", async () => {
    const location = await asDemo(
      async (c) =>
        (
          await c.query<{ location_id: string }>("SELECT location_id FROM person WHERE id = $1", [
            ADA,
          ])
        ).rows[0]?.location_id as string,
    );
    const fridge = await json<{ id: string }>(
      await post("manager", `/v1/locations/${location}/medicine-storage`, {
        kind: "fridge",
        name: "Medicines fridge",
      }),
    );
    const fine = await json<{
      reading: { outOfRange: boolean; lowCelsius: number; highCelsius: number };
    }>(await post("manager", `/v1/medicine-storage/${fridge.id}/readings`, { celsius: 5 }));
    expect(fine.reading).toMatchObject({ outOfRange: false, lowCelsius: 2, highCelsius: 8 });
    const warm = await post("manager", `/v1/medicine-storage/${fridge.id}/readings`, {
      celsius: 5,
      maxCelsius: 9.5,
    });
    expect(warm.status).toBe(201);
    const out = await json<{ reading: { outOfRange: boolean; taskId: string }; message: string }>(
      warm,
    );
    expect(out.reading.outOfRange).toBe(true);
    expect(out.message).not.toMatch(/safe to use|discard|still fine/i);
    const [raised] = (
      await asDemo((c) =>
        c.query<{ title: string; priority: string; due_at: Date; escalated_at: Date | null }>(
          "SELECT title, priority, due_at, escalated_at FROM task WHERE id = $1",
          [out.reading.taskId],
        ),
      )
    ).rows;
    expect(raised?.title).toBe(TEMPERATURE_TASK_TITLE);
    expect(raised?.priority).toBe("urgent");
    expect(new Date(raised?.due_at ?? 0).getTime()).toBeGreaterThan(Date.now() + 25 * MINUTE);
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    await escalateTasks(deps, new Date(Date.now() + 4 * 3_600_000));
    const after = await asDemo((c) =>
      c.query<{ escalated_at: Date | null }>("SELECT escalated_at FROM task WHERE id = $1", [
        out.reading.taskId,
      ]),
    );
    expect(after.rows[0]?.escalated_at).not.toBeNull();
  });
});
