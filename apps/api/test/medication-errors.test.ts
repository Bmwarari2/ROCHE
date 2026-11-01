import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Medication errors, reviews and reports through the API (Phase 2 slice 45; medicines.md section
 * 14; MEDS-012, MEDS-013; HZ-131). Fixtures are written as the owner role: a medication incident
 * about Ada, a controlled drug entry tagged psychotropic, a when-required entry, and doses.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const LOC = DEMO.locationId;
const INCIDENT = randomUUID();
const FALL = randomUUID();
const CD_ENTRY = randomUUID();
const PRN_ENTRY = randomUUID();
const DOSE = randomUUID();

const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const json = async <T>(r: Response) => (await r.json()) as T;

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

const blank = {
  medicationId: null,
  administrationId: null,
  kinds: [] as string[],
  stage: null,
  reachedPerson: null,
  controlledDrug: null,
  deliberateOrRepeated: null,
  immediateActions: null,
  clinicianToldAt: null,
  clinicianTold: null,
  adviceGiven: null,
  rootCause: null,
  cdReportedOn: null,
  cdReportReference: null,
};

interface ErrorOut {
  id: string;
  version: number;
  controlledDrug: string | null;
  controlledDrugPresumed: boolean;
  nearMiss: boolean | null;
  medicineName: string | null;
  source: string;
  kindWords: string[];
  prompts: { prompt: string; reason: string }[];
}

beforeAll(async () => {
  h = await createHarness();
  await asDemo(async (c) => {
    await c.query(
      `INSERT INTO incident (id, location_id, type, occurred_at, description, raised_by, person_ids)
       VALUES ($1, $3, 'medication', now() - interval '1 minute', 'Evening dose given late', $4, $5),
              ($2, $3, 'fall', now() - interval '1 hour', 'Slipped in the lounge', $4, $5)`,
      [INCIDENT, FALL, LOC, DEMO.users.carer.id, [ADA]],
    );
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
         source_reference, transcribed_by, transcribed_at, tags, cd_schedule)
       VALUES ($1, $2, $1, 1, 'transcribed', '90000011000001104', 'Lorazepam 1mg tablets',
         '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', now() - interval '2 days',
         'prescription', 'Prescription, 01/11/2026', $3, now() - interval '2 days',
         ARRAY['psychotropic'], '4.1')`,
      [CD_ENTRY, ADA, DEMO.users.manager.id],
    );
    await c.query(
      `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind, quantity,
         unit_code, unit_name)
       VALUES ($1, $2, 0, '08:00', 'amount', 1, '428673006', 'tablet')`,
      [CD_ENTRY, ADA],
    );
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, prescriber, starts_at, source_kind, source_reference,
         transcribed_by, transcribed_at, prn_dose, indication)
       VALUES ($1, $2, $1, 1, 'transcribed', '90000051000001100', 'Paracetamol 500mg tablets',
         '26643006', 'Oral', 'when_required', 'Dr A Example', now() - interval '2 days',
         'prescription', 'Prescription, 01/11/2026', $3, now() - interval '2 days',
         '{"kind": "amount", "quantity": 1, "unitCode": "428673006", "unitName": "tablet"}'::jsonb,
         'Pain')`,
      [PRN_ENTRY, ADA, DEMO.users.manager.id],
    );
    await c.query(
      `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome, quantity,
         unit_code, given_at, recorded_by, flags)
       VALUES ($1, $2, $3, now() - interval '3 minutes', 'given', 1, '428673006', now() - interval '3 minutes', $4,
         ARRAY['competence_override'])`,
      [DOSE, ADA, CD_ENTRY, DEMO.users.carer.id],
    );
    for (const hours of [5, 4]) {
      await c.query(
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, quantity,
           unit_code, given_at, recorded_by)
         VALUES ($5, $1, $2, 'given', 1, '428673006', now() - make_interval(mins => $3), $4)`,
        [ADA, PRN_ENTRY, hours, DEMO.users.carer.id, randomUUID()],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-131 medication errors on the incident (slice 45)", () => {
  let error: ErrorOut;

  it("adds details to a medication incident, presuming a controlled drug from the medicine, with prompts", async () => {
    const r = await send("carer", `/v1/incidents/${INCIDENT}/medication-error`, {
      method: "POST",
      body: {
        ...blank,
        personId: ADA,
        medicationId: CD_ENTRY,
        administrationId: DOSE,
        kinds: ["wrong_time"],
        stage: "administration",
        reachedPerson: "yes",
        deliberateOrRepeated: "no",
        immediateActions: "Checked Ada; observations as usual.",
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    error = await json<ErrorOut>(r);
    expect(error.controlledDrug).toBe("yes");
    expect(error.controlledDrugPresumed).toBe(true);
    expect(error.medicineName).toBe("Lorazepam 1mg tablets");
    expect(error.nearMiss).toBe(false);
    expect(error.source).toMatch(/NRLS/);
    expect(error.kindWords).toEqual(["Wrong time"]);
    expect(error.prompts.map((p) => p.prompt)).toEqual([
      "clinical_advice",
      "controlled_drug_report",
      "safeguarding_consideration",
      "cqc_through_classifier",
    ]);
  });

  it("reads it back, and audits with ids only", async () => {
    const r = await json<{ error: ErrorOut }>(
      await send("manager", `/v1/incidents/${INCIDENT}/medication-error`),
    );
    expect(r.error?.id).toBe(error.id);
    const rows = await asDemo((c) =>
      c.query("SELECT scope FROM audit_event WHERE action LIKE 'medicines.medication_error.%'"),
    );
    expect(JSON.stringify(rows.rows)).not.toMatch(/Checked Ada|wrong_time/);
  });

  it("refuses a second record, a non-medication incident, and half a clinician note, in words", async () => {
    const again = await send("carer", `/v1/incidents/${INCIDENT}/medication-error`, {
      method: "POST",
      body: { ...blank, personId: ADA },
    });
    expect(again.status).toBe(409);
    const fall = await send("carer", `/v1/incidents/${FALL}/medication-error`, {
      method: "POST",
      body: { ...blank, personId: ADA },
    });
    expect(fall.status).toBe(422);
    expect(JSON.stringify(await fall.json())).toMatch(/medication incident/);
    const half = await send("manager", `/v1/incidents/${INCIDENT}/medication-error`, {
      method: "PATCH",
      body: { ...blank, clinicianTold: "Out-of-hours GP", version: error.version },
    });
    expect(half.status).toBe(422);
    expect(JSON.stringify(await half.json())).toMatch(/who was told and when/);
  });

  it("clears the controlled drug prompt once its date and reference are recorded", async () => {
    const r = await send("manager", `/v1/incidents/${INCIDENT}/medication-error`, {
      method: "PATCH",
      body: {
        ...blank,
        medicationId: CD_ENTRY,
        administrationId: DOSE,
        kinds: ["wrong_time"],
        stage: "administration",
        reachedPerson: "yes",
        controlledDrug: "yes",
        deliberateOrRepeated: "no",
        cdReportedOn: ukIsoDate(new Date()),
        cdReportReference: "CDAO-2026-0001",
        version: error.version,
      },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const changed = await json<ErrorOut>(r);
    expect(changed.prompts.map((p) => p.prompt)).not.toContain("controlled_drug_report");
    // A stale version is refused as a conflict.
    const stale = await send("manager", `/v1/incidents/${INCIDENT}/medication-error`, {
      method: "PATCH",
      body: { ...blank, version: error.version },
    });
    expect(stale.status).toBe(409);
  });

  it("refuses a member who neither added it nor manages incidents changing it", async () => {
    const r = await send("nurse", `/v1/incidents/${INCIDENT}/medication-error`, {
      method: "PATCH",
      body: { ...blank, version: 9 },
    });
    expect([403, 409]).toContain(r.status);
  });

  it("counts it in the trend by month, kind and stage", async () => {
    const today = ukIsoDate(new Date());
    const r = await json<{ months: { errors: number; byKind: Record<string, number> }[] }>(
      await send(
        "manager",
        `/v1/locations/${LOC}/medication-errors/trend?from=${today.slice(0, 8)}01&to=${today}`,
      ),
    );
    expect(r.months.at(-1)?.errors).toBeGreaterThanOrEqual(1);
    expect(r.months.at(-1)?.byKind.wrong_time).toBeGreaterThanOrEqual(1);
  });
});

describe("hazard HZ-131 medication reviews (slice 45, MEDS-013)", () => {
  let reviewId = "";
  let version = 1;

  it("starts not scheduled, then shows a scheduled review as due soon", async () => {
    const before = await json<{ tracker: { status: string } }>(
      await send("manager", `/v1/people/${ADA}/medication-reviews`),
    );
    expect(before.tracker.status).toBe("not_scheduled");
    const due = ukIsoDate(new Date(Date.now() + 7 * 86_400_000));
    const made = await send("manager", `/v1/people/${ADA}/medication-reviews`, {
      method: "POST",
      body: { dueOn: due },
    });
    expect(made.status).toBe(201);
    const review = await json<{ id: string; version: number }>(made);
    reviewId = review.id;
    version = review.version;
    const after = await json<{ tracker: { status: string; statusWords: string } }>(
      await send("manager", `/v1/people/${ADA}/medication-reviews`),
    );
    expect(after.tracker.status).toBe("due_soon");
    expect(after.tracker.statusWords).toBe("Review due soon");
  });

  it("records it done by a named clinician, then needs a reason to change it", async () => {
    const done = await send("manager", `/v1/medication-reviews/${reviewId}/done`, {
      method: "POST",
      body: {
        doneOn: ukIsoDate(new Date()),
        clinicianName: "Dr Ada Example",
        clinicianRole: "gp",
        outcome: "No changes.",
        version,
      },
    });
    expect(done.status, await done.clone().text()).toBe(200);
    version = (await json<{ version: number }>(done)).version;
    const noReason = await send("manager", `/v1/medication-reviews/${reviewId}/done`, {
      method: "POST",
      body: {
        doneOn: ukIsoDate(new Date()),
        clinicianName: "Dr Ada Example",
        clinicianRole: "gp",
        outcome: "Stop it.",
        version,
      },
    });
    expect(noReason.status).toBe(422);
    const tracker = await json<{ items: { personId: string; status: string; nextFrom: string }[] }>(
      await send("manager", `/v1/locations/${LOC}/medication-reviews`),
    );
    const ada = tracker.items.find((i) => i.personId === ADA);
    expect(ada?.status).toBe("scheduled");
    expect(ada?.nextFrom).toBe("interval");
  });

  it("refuses a review recorded as done in the future, and a carer reading reviews", async () => {
    const future = await send("manager", `/v1/medication-reviews/${reviewId}/done`, {
      method: "POST",
      body: {
        doneOn: ukIsoDate(new Date(Date.now() + 3 * 86_400_000)),
        clinicianName: "Dr Ada Example",
        clinicianRole: "gp",
        outcome: "No changes.",
        correctionReason: "Date typed wrongly",
        version,
      },
    });
    expect(future.status).toBe(422);
    expect((await send("carer", `/v1/people/${ADA}/medication-reviews`)).status).toBe(403);
  });
});

describe("hazard HZ-131 the reports are counts, information only (slice 45)", () => {
  const today = () => ukIsoDate(new Date());

  it("counts competence overrides per member", async () => {
    const r = await json<{ items: { memberId: string; competenceOverride: number }[] }>(
      await send(
        "manager",
        `/v1/locations/${LOC}/medicines/override-report?from=${today()}&to=${today()}`,
      ),
    );
    expect(r.items.find((i) => i.memberId === DEMO.users.carer.id)?.competenceOverride).toBe(1);
  });

  it("counts PRN and psychotropic doses per person, with its note", async () => {
    const r = await json<{
      note: string;
      items: { personId: string; prnGiven: number; psychotropicGiven: number }[];
    }>(
      await send(
        "manager",
        `/v1/locations/${LOC}/medicines/prn-report?from=${today()}&to=${today()}`,
      ),
    );
    expect(r.note).toMatch(/does not judge/);
    const ada = r.items.find((i) => i.personId === ADA);
    expect(ada?.prnGiven).toBe(2);
    expect(ada?.psychotropicGiven).toBe(1);
  });

  it("refuses a period that ends before it starts, and a carer", async () => {
    expect(
      (
        await send(
          "manager",
          `/v1/locations/${LOC}/medicines/prn-report?from=2026-11-02&to=2026-11-01`,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await send(
          "carer",
          `/v1/locations/${LOC}/medicines/prn-report?from=${today()}&to=${today()}`,
        )
      ).status,
    ).toBe(403);
  });
});
