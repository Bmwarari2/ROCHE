import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { addDaysToDate, ukDateOf, ukIsoDate, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { createHarness, type Harness } from "./support/harness";

/**
 * PRN protocols, outcomes, the organisation's medicine lists and the PRN frequency report through
 * the API (Phase 2 slice 28; medicines.md section 16; MEDS-003; HZ-117). Fixtures: a when-required
 * entry for Ada (transcribed from yesterday), a dose given now through the API and one given three
 * hours ago written as the owner role.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const LOC = DEMO.locationId;
const PRODUCT = { vmpId: "90000051000001100", ampId: null, name: "Lactulose" };
const ORAL = { code: "26643006", name: "Oral" };
const ML = { code: "258773002", name: "ml" };
const competence = fixedCompetence();
const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const json = async <T>(r: Response) => (await r.json()) as T;
const today = () => ukIsoDate(new Date());
const yesterday = () => addDaysToDate(today(), -1);

let entryId = "";
let doseNow = "";
let doseEarlier = "";

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

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  for (const u of ["owner", "manager", "carer"] as const) {
    competence.held.set(`${DEMO.tenantId}:${DEMO.users[u].id}`, "current");
  }
  const r = await send("manager", `/v1/people/${ADA}/medicines`, {
    method: "POST",
    body: {
      product: PRODUCT,
      route: ORAL,
      prescriber: "Dr A Example",
      startsAt: ukStartOfDay(ukDateOf(new Date(Date.now() - 86_400_000))).toISOString(),
      source: { kind: "prescription", reference: "Prescription, Dr A Example, 01/11/2026" },
      indication: "Constipation",
      directions: {
        kind: "when_required",
        dose: { kind: "amount", quantity: 15, unit: ML },
        maxQuantityPer24Hours: 60,
      },
    },
  });
  expect(r.status, await r.clone().text()).toBe(201);
  entryId = (await json<{ id: string }>(r)).id;
  const given = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
    method: "POST",
    body: {
      id: randomUUID(),
      entryId,
      outcome: "given",
      amount: { quantity: 15, unitCode: ML.code },
    },
  });
  expect(given.status, await given.clone().text()).toBe(201);
  doseNow = (await json<{ administration: { id: string } }>(given)).administration.id;
  doseEarlier = randomUUID();
  await asDemo((c) =>
    c.query(
      `INSERT INTO medication_administration (id, person_id, medication_id, outcome, quantity,
         unit_code, given_at, recorded_by)
       VALUES ($1, $2, $3, 'given', 15, $4, now() - interval '3 hours', $5)`,
      [doseEarlier, ADA, entryId, ML.code, DEMO.users.manager.id],
    ),
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-117 the organisation's medicine lists hold exact products (slice 28)", () => {
  let itemId = "";

  it("lets a holder of medicines.list.manage add a product once, and refuses a carer", async () => {
    const add = (user: string) =>
      send(user, "/v1/medicine-lists/psychotropic", {
        method: "POST",
        body: { vmpId: PRODUCT.vmpId, productName: PRODUCT.name, reason: "For the test" },
      });
    expect((await add("carer")).status).toBe(403);
    const r = await add("manager");
    expect(r.status, await r.clone().text()).toBe(201);
    itemId = (await json<{ id: string }>(r)).id;
    const again = await add("manager");
    expect(again.status).toBe(422);
    expect(JSON.stringify(await again.json())).toMatch(/already on the list/);
    const list = await json<{ items: { vmpId: string }[] }>(
      await send("carer", "/v1/medicine-lists/psychotropic"),
    );
    expect(list.items.map((i) => i.vmpId)).toEqual([PRODUCT.vmpId]);
  });

  it("refuses a name in place of a dm+d product", async () => {
    const r = await send("manager", "/v1/medicine-lists/psychotropic", {
      method: "POST",
      body: { vmpId: "lorazepam", productName: "Lorazepam", reason: null },
    });
    expect(r.status).toBe(422);
  });

  it("keeps a removal, with its reason", async () => {
    const extra = await json<{ id: string; version: number }>(
      await send("manager", "/v1/medicine-lists/time_critical", {
        method: "POST",
        body: {
          vmpId: "90000011000001104",
          productName: "Paracetamol 500mg tablets",
          reason: null,
        },
      }),
    );
    const r = await send("manager", `/v1/medicine-list-items/${extra.id}/remove`, {
      method: "POST",
      body: { reason: "Added by mistake", version: extra.version },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await json<{ removedReason: string }>(r)).removedReason).toBe("Added by mistake");
    expect(itemId).not.toBe("");
  });
});

describe("hazard HZ-117 PRN protocols show the prescriber's limits and never copy them (slice 28)", () => {
  const protocol = (extra: Record<string, unknown> = {}) => ({
    medicationId: entryId,
    purpose: "Constipation for more than two days",
    triggers: ["No bowel movement for two days", "Discomfort in the abdomen"],
    nonDrugAlternatives: ["Extra fluids", "Prune juice at breakfast"],
    purposeGroup: "Constipation",
    orderOfUse: 1,
    expectedEffect: "Bowel movement within two days",
    agreedWithName: "Dr A Example",
    agreedWithRole: "prescriber",
    agreedOn: yesterday(),
    reviewOn: addDaysToDate(today(), 90),
    ...extra,
  });
  let protocolId = "";
  let version = 1;

  it("refuses a carer, and a review past the rate table's days, in words", async () => {
    expect(
      (await send("carer", `/v1/people/${ADA}/prn-protocols`, { method: "POST", body: protocol() }))
        .status,
    ).toBe(403);
    const far = await send("manager", `/v1/people/${ADA}/prn-protocols`, {
      method: "POST",
      body: protocol({ reviewOn: addDaysToDate(today(), 400) }),
    });
    expect(far.status).toBe(422);
    expect(JSON.stringify(await far.json())).toMatch(/further away than your organisation allows/);
  });

  it("records one open protocol per medicine, showing the entry's limits and the psychotropic list", async () => {
    const r = await send("manager", `/v1/people/${ADA}/prn-protocols`, {
      method: "POST",
      body: protocol(),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const out = await json<{
      id: string;
      version: number;
      limits: { maxPer24h: number | null; dose: string | null; indication: string | null };
      psychotropic: boolean;
      status: string;
    }>(r);
    protocolId = out.id;
    version = out.version;
    expect(out.limits.maxPer24h).toBe(60);
    expect(out.limits.dose).toMatch(/15/);
    expect(out.limits.indication).toBe("Constipation");
    expect(out.psychotropic).toBe(true);
    expect(out.status).toBe("in_use");
    const sameOrder = await send("manager", `/v1/people/${ADA}/prn-protocols`, {
      method: "POST",
      body: protocol(),
    });
    expect(sameOrder.status).toBe(422);
    expect(JSON.stringify(await sameOrder.json())).toMatch(/already has that place/);
    const again = await send("manager", `/v1/people/${ADA}/prn-protocols`, {
      method: "POST",
      body: protocol({ purposeGroup: null, orderOfUse: null }),
    });
    expect(again.status).toBe(409);
  });

  it("changes it with a reason and the version read", async () => {
    const body = { ...protocol(), reason: "Reviewed with the GP" } as Record<string, unknown>;
    delete body.medicationId;
    const stale = await send("manager", `/v1/prn-protocols/${protocolId}/change`, {
      method: "POST",
      body: { ...body, version: version + 3 },
    });
    expect(stale.status).toBe(409);
    const r = await send("manager", `/v1/prn-protocols/${protocolId}/change`, {
      method: "POST",
      body: { ...body, triggers: ["No bowel movement for three days"], version },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    version = (await json<{ version: number }>(r)).version;
    const list = await json<{ items: { triggers: string[] }[] }>(
      await send("carer", `/v1/people/${ADA}/prn-protocols`),
    );
    expect(list.items[0]?.triggers).toEqual(["No bowel movement for three days"]);
  });

  it("hazard HZ-117 a changed prescription is what the protocol shows", async () => {
    const v2 = await send("manager", `/v1/medicines/${entryId}/versions`, {
      method: "POST",
      body: {
        product: PRODUCT,
        route: ORAL,
        prescriber: "Dr A Example",
        startsAt: ukStartOfDay(ukDateOf(new Date(Date.now() + 86_400_000))).toISOString(),
        source: { kind: "prescription", reference: "Prescription, Dr A Example, 06/11/2026" },
        indication: "Constipation",
        directions: {
          kind: "when_required",
          dose: { kind: "amount", quantity: 10, unit: ML },
          maxQuantityPer24Hours: 30,
        },
        expectedVersion: 1,
      },
    });
    expect(v2.status, await v2.clone().text()).toBe(201);
    const list = await json<{
      items: { limits: { maxPer24h: number | null; dose: string | null } }[];
    }>(await send("carer", `/v1/people/${ADA}/prn-protocols`));
    expect(list.items[0]?.limits.maxPer24h).toBe(30);
    expect(list.items[0]?.limits.dose).toMatch(/^10/);
  });
});

describe("hazard HZ-117 the outcome of a when-required dose is followed up (slice 28)", () => {
  let outcomeId = "";

  it("lists the earlier dose as outstanding once its check is due", async () => {
    const r = await json<{ items: { administrationId: string; medicineName: string }[] }>(
      await send("carer", `/v1/people/${ADA}/prn-outcomes/outstanding`),
    );
    expect(r.items.map((i) => i.administrationId)).toEqual([doseEarlier]);
    expect(r.items[0]?.medicineName).toMatch(/^Lactulose/);
    // The dose given just now is not yet due.
    expect(r.items.map((i) => i.administrationId)).not.toContain(doseNow);
  });

  it("refuses an outcome seen before the dose, records one once per id, and corrects it with a reason", async () => {
    const before = await send("carer", `/v1/medicine-administrations/${doseEarlier}/prn-outcome`, {
      method: "POST",
      body: {
        id: randomUUID(),
        outcome: "effective",
        note: null,
        observedAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
      },
    });
    expect(before.status).toBe(422);
    const body = {
      id: randomUUID(),
      outcome: "effective",
      note: "Settled",
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const r = await send("carer", `/v1/medicine-administrations/${doseEarlier}/prn-outcome`, {
      method: "POST",
      body,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    outcomeId = (await json<{ id: string }>(r)).id;
    const resent = await send("carer", `/v1/medicine-administrations/${doseEarlier}/prn-outcome`, {
      method: "POST",
      body,
    });
    expect(resent.status).toBe(200);
    const second = await send("carer", `/v1/medicine-administrations/${doseEarlier}/prn-outcome`, {
      method: "POST",
      body: { ...body, id: randomUUID() },
    });
    expect(second.status).toBe(409);
    const corrected = await send(
      "carer",
      `/v1/medicine-administrations/${doseEarlier}/prn-outcome`,
      {
        method: "POST",
        body: {
          ...body,
          id: randomUUID(),
          outcome: "partly_effective",
          correction: { supersedesId: outcomeId, reason: "Still uncomfortable later" },
        },
      },
    );
    expect(corrected.status, await corrected.clone().text()).toBe(201);
    const after = await json<{ items: unknown[] }>(
      await send("carer", `/v1/people/${ADA}/prn-outcomes/outstanding`),
    );
    expect(after.items).toEqual([]);
  });
});

describe("hazard HZ-117 the PRN frequency report counts, never judges (slice 28)", () => {
  const report = (user: string, query: string) =>
    send(user, `/v1/locations/${LOC}/medicines/prn-frequency?${query}`);

  it("counts doses, outcomes and psychotropic medicines, with its note; a backdated agreement covers no earlier dose", async () => {
    const after = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId,
        outcome: "given",
        amount: { quantity: 15, unitCode: ML.code },
      },
    });
    expect(after.status, await after.clone().text()).toBe(201);
    const r = await report("manager", `from=${yesterday()}&to=${today()}&psychotropicOnly=true`);
    expect(r.status, await r.clone().text()).toBe(200);
    const out = await json<{
      note: string;
      items: {
        personId: string;
        medicineName: string;
        psychotropic: boolean;
        doses: number;
        withoutProtocol: number;
        outcomes: Record<string, number>;
      }[];
    }>(r);
    expect(out.note).toMatch(/does not judge/);
    const ada = out.items.find((i) => i.personId === ADA);
    expect(ada?.medicineName).toMatch(/^Lactulose/);
    expect(ada?.psychotropic).toBe(true);
    expect(ada?.doses).toBe(3);
    // The protocol was agreed "yesterday" but recorded after the first two doses.
    expect(ada?.withoutProtocol).toBe(2);
    expect(ada?.outcomes.partly_effective).toBe(1);
    expect(ada?.outcomes.effective).toBe(0);
  });

  it("refuses the report at another home to a manager of this one", async () => {
    const elsewhere = randomUUID();
    await asDemo((c) =>
      c.query("INSERT INTO location (id, name) VALUES ($1, 'Riverside House')", [elsewhere]),
    );
    const r = await send(
      "manager",
      `/v1/locations/${elsewhere}/medicines/prn-frequency?from=${yesterday()}&to=${today()}`,
    );
    expect(r.status).toBe(403);
    // The owner, across the organisation, may read it: an empty home has no lines.
    const owner = await send(
      "owner",
      `/v1/locations/${elsewhere}/medicines/prn-frequency?from=${yesterday()}&to=${today()}`,
    );
    expect(owner.status, await owner.clone().text()).toBe(200);
    expect((await json<{ items: unknown[] }>(owner)).items).toEqual([]);
  });

  it("refuses a period past the rate table's days, a reversed period, and a carer", async () => {
    expect((await report("manager", "from=2024-01-01&to=2026-11-01")).status).toBe(422);
    expect((await report("manager", `from=${today()}&to=${yesterday()}`)).status).toBe(422);
    expect((await report("carer", `from=${yesterday()}&to=${today()}`)).status).toBe(403);
  });
});
