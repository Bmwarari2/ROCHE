import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { addDaysToDate, ukDateOf, ukIsoDate, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { createHarness, type Harness } from "./support/harness";

/**
 * Covert administration, self-administration and homely remedies through the API (Phase 2 slice
 * 38; medicines.md section 15; MEDS-004, MEDS-006, MEDS-007; HZ-026, HZ-120). Fixtures: Ada, a
 * capacity assessment for covert medicines finding a lack of capacity with its best-interests
 * decision, an assessment of another decision, and a when-required paracetamol entry.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const LOC = DEMO.locationId;
const PARACETAMOL = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
const ORAL = { code: "26643006", name: "Oral" };
const TABLET = { code: "428673006", name: "tablet" };
const competence = fixedCompetence();
const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const json = async <T>(r: Response) => (await r.json()) as T;
const today = () => ukIsoDate(new Date());

const CHECKLIST = JSON.stringify(
  Object.fromEntries(
    [
      "no_unjustified_assumptions",
      "relevant_circumstances",
      "regaining_capacity",
      "participation",
      "life_sustaining_treatment",
      "wishes_and_feelings",
      "beliefs_and_values",
      "other_factors",
      "views_of_others",
      "less_restrictive_option",
    ].map((k) => [k, { answer: "considered", note: "Talked it through." }]),
  ),
);

let entryId = "";
let medicineId = "";
let covertCapacity = "";
let otherCapacity = "";
let bestInterests = "";

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
  administration: { id: string; flags: string[]; covert: boolean };
  escalations: { severity: string }[];
}

const dose = (outcome: string, covert: boolean) =>
  send("manager", `/v1/people/${ADA}/medicine-administrations`, {
    method: "POST",
    body: {
      id: randomUUID(),
      entryId,
      outcome,
      amount: { quantity: 2, unitCode: TABLET.code },
      covert,
    },
  });

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  for (const u of ["owner", "manager", "carer"] as const) {
    competence.held.set(`${DEMO.tenantId}:${DEMO.users[u].id}`, "current");
  }
  const r = await send("manager", `/v1/people/${ADA}/medicines`, {
    method: "POST",
    body: {
      product: PARACETAMOL,
      route: ORAL,
      prescriber: "Dr A Example",
      startsAt: ukStartOfDay(ukDateOf(new Date())).toISOString(),
      source: { kind: "prescription", reference: "Prescription, Dr A Example, 01/11/2026" },
      indication: "Pain",
      directions: {
        kind: "when_required",
        dose: { kind: "amount", quantity: 2, unit: TABLET },
        maxQuantityPer24Hours: 20,
      },
    },
  });
  expect(r.status, await r.clone().text()).toBe(201);
  entryId = (await json<{ id: string }>(r)).id;
  await asDemo(async (c) => {
    medicineId = (await c.query("SELECT medicine_id FROM medication WHERE id = $1", [entryId]))
      .rows[0].medicine_id;
    const assess = (kind: string) =>
      c.query(
        `INSERT INTO capacity_assessment (person_id, decision, decision_kind, assessed_at,
           assessor_tenant_user_id, stage1_impairment, stage1_description, stage2,
           inability_because_of_impairment, outcome, unable_to, reason)
         VALUES ($1, 'whether to take medicines hidden in food', $2, now() - interval '2 days',
           $3, true, 'Dementia', '{}', true, 'lacks_capacity', '{understand}', 'Recorded')
         RETURNING id`,
        [ADA, kind, DEMO.users.manager.id],
      );
    covertCapacity = (await assess("covert_medicines")).rows[0].id;
    otherCapacity = (await assess("sharing")).rows[0].id;
    bestInterests = (
      await c.query(
        `INSERT INTO best_interests_decision (person_id, capacity_assessment_id, decision,
           decided_at, checklist, consultations, review_on)
         VALUES ($1, $2, 'Give paracetamol in yoghurt', now() - interval '1 day', $3,
           '[{"consultee":"family_or_friend","views":"Agrees","consultedAt":"2026-10-10T10:00:00Z"}]',
           '2099-01-10') RETURNING id`,
        [ADA, covertCapacity, CHECKLIST],
      )
    ).rows[0].id;
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-026 covert administration under a best-interests decision (slice 38)", () => {
  const attendees = [
    { role: "prescriber", name: "Dr A Example" },
    { role: "pharmacist", name: "B Example" },
  ];
  const record = () => ({
    medicationId: entryId,
    capacityAssessmentId: covertCapacity,
    bestInterestsDecisionId: bestInterests,
    attendees,
    method: "Crushed and mixed in a spoon of yoghurt",
    pharmacistAdvice: "May be crushed; give straight away",
    startsOn: today(),
    reviewOn: addDaysToDate(today(), 30),
  });
  let covertId = "";
  let version = 1;

  it("refuses a member without medicines.covert.manage", async () => {
    const r = await send("carer", `/v1/people/${ADA}/covert-medicines`, {
      method: "POST",
      body: record(),
    });
    expect(r.status).toBe(403);
  });

  it("refuses without a pharmacist, on another decision's assessment, and past the review limit, in words", async () => {
    const noPharmacist = await send("manager", `/v1/people/${ADA}/covert-medicines`, {
      method: "POST",
      body: { ...record(), attendees: [attendees[0]] },
    });
    expect(noPharmacist.status).toBe(422);
    expect(JSON.stringify(await noPharmacist.json())).toMatch(/pharmacist must be part/);
    const other = await send("manager", `/v1/people/${ADA}/covert-medicines`, {
      method: "POST",
      body: { ...record(), capacityAssessmentId: otherCapacity },
    });
    expect(other.status).toBe(422);
    expect(JSON.stringify(await other.json())).toMatch(/about giving medicines covertly/);
    const far = await send("manager", `/v1/people/${ADA}/covert-medicines`, {
      method: "POST",
      body: { ...record(), reviewOn: addDaysToDate(today(), 400) },
    });
    expect(far.status).toBe(422);
  });

  it("records one open record per medicine, and marks a covert dose under it without a flag", async () => {
    const r = await send("manager", `/v1/people/${ADA}/covert-medicines`, {
      method: "POST",
      body: record(),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const out = await json<{ id: string; version: number; status: string; medicineId: string }>(r);
    covertId = out.id;
    version = out.version;
    expect(out.status).toBe("current");
    expect(out.medicineId).toBe(medicineId);
    const again = await send("manager", `/v1/people/${ADA}/covert-medicines`, {
      method: "POST",
      body: record(),
    });
    expect(again.status).toBe(409);
    const given = await dose("given", true);
    expect(given.status, await given.clone().text()).toBe(201);
    const marked = await json<Recorded>(given);
    expect(marked.administration.covert).toBe(true);
    expect(marked.administration.flags).not.toContain("covert_without_record");
    expect(marked.escalations).toEqual([]);
  });

  it("keeps a covert dose's mark through a correction that leaves it out", async () => {
    const given = await dose("given", true);
    expect(given.status, await given.clone().text()).toBe(201);
    const original = (await json<Recorded>(given)).administration;
    const r = await send("manager", `/v1/medicine-administrations/${original.id}/corrections`, {
      method: "POST",
      body: {
        id: randomUUID(),
        correctionReason: "Recorded against the wrong time",
        entryId,
        outcome: "given",
        amount: { quantity: 2, unitCode: TABLET.code },
        givenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    expect((await json<Recorded>(r)).administration.covert).toBe(true);
  });

  it("reviews it with a reason and the version read", async () => {
    const body = {
      capacityAssessmentId: covertCapacity,
      bestInterestsDecisionId: bestInterests,
      attendees,
      method: "Mixed in yoghurt",
      pharmacistAdvice: "May be crushed; give straight away",
      reviewedOn: today(),
      reviewOn: addDaysToDate(today(), 60),
      reason: "Monthly review with the GP and pharmacist",
    };
    const stale = await send("manager", `/v1/covert-medicines/${covertId}/review`, {
      method: "POST",
      body: { ...body, version: version + 5 },
    });
    expect(stale.status).toBe(409);
    const r = await send("manager", `/v1/covert-medicines/${covertId}/review`, {
      method: "POST",
      body: { ...body, version },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const out = await json<{ version: number; reviewedOn: string }>(r);
    expect(out.reviewedOn).toBe(today());
    version = out.version;
  });

  it("ends it, after which a covert dose is recorded, flagged and escalated urgently", async () => {
    const r = await send("manager", `/v1/covert-medicines/${covertId}/end`, {
      method: "POST",
      body: { endedOn: today(), reason: "Now takes it openly", version },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await json<{ status: string }>(r)).status).toBe("ended");
    const given = await dose("given", true);
    expect(given.status, await given.clone().text()).toBe(201);
    const out = await json<Recorded>(given);
    expect(out.administration.flags).toContain("covert_without_record");
    expect(out.escalations.map((e) => e.severity)).toEqual(["urgent"]);
    const list = await json<{ items: { status: string }[] }>(
      await send("carer", `/v1/people/${ADA}/covert-medicines`),
    );
    expect(list.items.map((i) => i.status)).toEqual(["ended"]);
  });
});

describe("hazard HZ-026 a covert record stops covering doses once its basis changes (slice 38)", () => {
  it("refuses covert on a dose that was not given", async () => {
    const r = await dose("refused", true);
    expect(r.status).toBe(422);
  });

  it("shows the record as needing review, and flags covert doses urgently, once a later assessment finds capacity", async () => {
    const made = await send("manager", `/v1/people/${ADA}/covert-medicines`, {
      method: "POST",
      body: {
        medicationId: entryId,
        capacityAssessmentId: covertCapacity,
        bestInterestsDecisionId: bestInterests,
        attendees: [
          { role: "prescriber", name: "Dr A Example" },
          { role: "pharmacist", name: "B Example" },
        ],
        method: "In yoghurt",
        pharmacistAdvice: "May be crushed",
        startsOn: today(),
        reviewOn: addDaysToDate(today(), 30),
      },
    });
    expect(made.status, await made.clone().text()).toBe(201);
    await asDemo((c) =>
      c.query(
        `INSERT INTO capacity_assessment (person_id, decision, decision_kind, assessed_at,
           assessor_tenant_user_id, stage1_impairment, stage2, outcome, reason)
         VALUES ($1, 'whether to take medicines hidden in food', 'covert_medicines', now(), $2,
           false, '{}', 'has_capacity', 'Recorded')`,
        [ADA, DEMO.users.manager.id],
      ),
    );
    const list = await json<{ items: { status: string }[] }>(
      await send("manager", `/v1/people/${ADA}/covert-medicines`),
    );
    expect(list.items.map((i) => i.status)).toContain("basis_changed");
    const given = await json<Recorded>(await dose("given", true));
    expect(given.administration.flags).toContain("covert_without_record");
    expect(given.escalations.map((e) => e.severity)).toEqual(["urgent"]);
  });
});

describe("hazard HZ-120 self-administration is assessed before it is relied on (slice 38)", () => {
  const assessment = () => ({
    medicineIds: [medicineId],
    choice: "wants_to",
    capacity: "assumed",
    capacityAssessmentId: null,
    dexterity: "able",
    storage: "lockable_storage",
    level: "self_administers",
    notes: "Keeps them in the locked drawer.",
    assessedOn: today(),
    reviewOn: addDaysToDate(today(), 90),
  });

  it("flags and escalates a dose the person took with no assessment, never refusing it", async () => {
    const r = await dose("self_administered", false);
    expect(r.status, await r.clone().text()).toBe(201);
    const out = await json<Recorded>(r);
    expect(out.administration.flags).toContain("self_admin_not_assessed");
    expect(out.escalations.map((e) => e.severity)).toEqual(["warning"]);
  });

  it("refuses self-administering without lockable storage, and another person's medicine", async () => {
    const r = await send("manager", `/v1/people/${ADA}/self-administration`, {
      method: "POST",
      body: { ...assessment(), storage: "no_lockable_storage" },
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toMatch(/lockable storage/);
    const other = await send("manager", `/v1/people/${ADA}/self-administration`, {
      method: "POST",
      body: { ...assessment(), medicineIds: [randomUUID()] },
    });
    expect(other.status).toBe(422);
    expect(JSON.stringify(await other.json())).toMatch(/own medicines/);
  });

  it("records an assessment, after which the person's doses carry no flag", async () => {
    const r = await send("manager", `/v1/people/${ADA}/self-administration`, {
      method: "POST",
      body: assessment(),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const taken = await json<Recorded>(await dose("self_administered", false));
    expect(taken.administration.flags).not.toContain("self_admin_not_assessed");
    const read = await json<{ medicines: { medicineId: string; status: string }[] }>(
      await send("manager", `/v1/people/${ADA}/self-administration`),
    );
    expect(read.medicines.find((m) => m.medicineId === medicineId)?.status).toBe("current");
  });

  it("refuses a carer recording an assessment", async () => {
    const r = await send("carer", `/v1/people/${ADA}/self-administration`, {
      method: "POST",
      body: assessment(),
    });
    expect(r.status).toBe(403);
  });
});

describe("hazard HZ-120 homely remedies only within the home's protocol (slice 38)", () => {
  const protocol = (extra: Record<string, unknown> = {}) => ({
    productName: "Simple linctus",
    vmpId: null,
    indication: "Dry cough",
    doseQuantity: 5,
    unitName: "ml",
    minIntervalHours: 4,
    maxDailyQuantity: 20,
    maxDays: 2,
    authorisedMemberIds: [DEMO.users.carer.id],
    approvedByName: "Dr A Example",
    approvedByRole: "gp",
    approvedOn: today(),
    reviewOn: addDaysToDate(today(), 365),
    ...extra,
  });
  let protocolId = "";
  let protocolVersion = 1;
  let firstDose = "";
  const give = (user: string, body: Record<string, unknown> = {}) =>
    send(user, `/v1/people/${ADA}/homely-remedy-doses`, {
      method: "POST",
      body: {
        id: randomUUID(),
        protocolId,
        quantity: 5,
        reason: "Coughing at night",
        allergiesChecked: true,
        medicinesCompared: true,
        ...body,
      },
    });

  it("refuses a carer adding a protocol, and more days than the rate table allows", async () => {
    expect(
      (
        await send("carer", `/v1/locations/${LOC}/homely-remedies`, {
          method: "POST",
          body: protocol(),
        })
      ).status,
    ).toBe(403);
    const r = await send("manager", `/v1/locations/${LOC}/homely-remedies`, {
      method: "POST",
      body: protocol({ maxDays: 30 }),
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toMatch(/days before the GP is asked/);
  });

  it("adds a protocol and gives a dose by a named member, once per id", async () => {
    const r = await send("manager", `/v1/locations/${LOC}/homely-remedies`, {
      method: "POST",
      body: protocol(),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const out = await json<{ id: string; version: number; status: string }>(r);
    protocolId = out.id;
    protocolVersion = out.version;
    expect(out.status).toBe("in_use");
    firstDose = randomUUID();
    const given = await give("carer", { id: firstDose });
    expect(given.status, await given.clone().text()).toBe(201);
    const resent = await give("carer", { id: firstDose });
    expect(resent.status).toBe(200);
  });

  it("refuses outside the protocol, in words: not named, another dose, too soon", async () => {
    const notNamed = await give("manager");
    expect(notNamed.status).toBe(422);
    expect(JSON.stringify(await notNamed.json())).toMatch(/not named on this protocol/);
    const other = await give("carer", { quantity: 10 });
    expect(other.status).toBe(422);
    expect(JSON.stringify(await other.json())).toMatch(/dose the protocol states/);
    const soon = await give("carer");
    expect(soon.status).toBe(422);
    expect(JSON.stringify(await soon.json())).toMatch(/too soon/);
  });

  it("says before giving whether a dose is within the protocol, recording nothing", async () => {
    const r = await send("carer", `/v1/people/${ADA}/homely-remedy-doses/check`, {
      method: "POST",
      body: { protocolId, quantity: 5 },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(
      (await json<{ problems: { problem: string }[] }>(r)).problems.map((p) => p.problem),
    ).toEqual(["too_soon"]);
  });

  it("hazard HZ-120 refuses a dose unless the giver compared it with the current medicines", async () => {
    // The API matches only the same dm+d product, so the comparison is the giver's; never assumed.
    for (const medicinesCompared of [false, undefined]) {
      const notCompared = await give("carer", { medicinesCompared });
      expect(notCompared.status).toBe(422);
      expect(JSON.stringify(await notCompared.json())).toMatch(/medicinesCompared/);
    }
  });

  it("records a dose already given outside the protocol with its flags, escalated urgently", async () => {
    const noAllergyCheck = await give("carer", { allergiesChecked: false });
    expect(noAllergyCheck.status).toBe(422);
    const r = await give("carer", {
      alreadyGiven: {
        givenAt: new Date(Date.now() - 60_000).toISOString(),
        reason: "Given at night before checking the record",
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const out = await json<{ id: string; flags: string[] }>(r);
    expect(out.flags).toEqual(["too_soon"]);
    const tasks = await asDemo((c) =>
      c.query("SELECT priority FROM task WHERE source_id = $1", [out.id]),
    );
    expect(tasks.rows.map((t) => t.priority)).toEqual(["urgent"]);
    // It counts like any dose: the next is refused as too soon. Mark it entered in error after.
    await send("manager", `/v1/homely-remedy-doses/${out.id}/entered-in-error`, {
      method: "POST",
      body: { id: randomUUID(), reason: "Test record" },
    });
  });

  it("marks a dose entered in error, after which it no longer counts", async () => {
    const mark = { id: randomUUID(), reason: "Recorded for the wrong person" };
    const r = await send("carer", `/v1/homely-remedy-doses/${firstDose}/entered-in-error`, {
      method: "POST",
      body: mark,
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const again = await send("carer", `/v1/homely-remedy-doses/${firstDose}/entered-in-error`, {
      method: "POST",
      body: mark,
    });
    expect(again.status).toBe(200);
    const list = await json<{ items: { id: string; enteredInErrorBy: string | null }[] }>(
      await send("manager", `/v1/people/${ADA}/homely-remedy-doses`),
    );
    expect(list.items.find((i) => i.id === firstDose)?.enteredInErrorBy).not.toBeNull();
    expect((await give("carer")).status).toBe(201);
  });

  it("refuses a product the person has prescribed", async () => {
    const r = await send("manager", `/v1/locations/${LOC}/homely-remedies`, {
      method: "POST",
      body: protocol({
        productName: PARACETAMOL.name,
        vmpId: PARACETAMOL.vmpId,
        doseQuantity: 2,
        unitName: "tablet",
        maxDailyQuantity: 8,
      }),
    });
    const para = await json<{ id: string }>(r);
    const given = await send("carer", `/v1/people/${ADA}/homely-remedy-doses`, {
      method: "POST",
      body: {
        id: randomUUID(),
        protocolId: para.id,
        quantity: 2,
        reason: "Headache",
        allergiesChecked: true,
        medicinesCompared: true,
      },
    });
    expect(given.status).toBe(422);
    expect(JSON.stringify(await given.json())).toMatch(/has this product prescribed/);
  });

  it("withdraws a protocol with a reason, after which no dose is given under it", async () => {
    const r = await send("manager", `/v1/homely-remedies/${protocolId}/withdraw`, {
      method: "POST",
      body: { reason: "GP asked us to stop using it", version: protocolVersion },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const after = await give("carer");
    expect(after.status).toBe(422);
    expect(JSON.stringify(await after.json())).toMatch(/withdrawn/);
    const list = await json<{ items: { id: string; status: string }[] }>(
      await send("carer", `/v1/locations/${LOC}/homely-remedies`),
    );
    expect(list.items.find((i) => i.id === protocolId)?.status).toBe("withdrawn");
    // A replacement protocol for the same product does not start a fresh gap.
    const replacement = await json<{ id: string }>(
      await send("manager", `/v1/locations/${LOC}/homely-remedies`, {
        method: "POST",
        body: protocol(),
      }),
    );
    const soon = await give("carer", { protocolId: replacement.id });
    expect(soon.status).toBe(422);
    expect(JSON.stringify(await soon.json())).toMatch(/too soon/);
  });
});
