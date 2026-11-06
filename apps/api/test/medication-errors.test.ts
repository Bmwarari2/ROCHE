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
const CLOSED = randomUUID();
/** About Ada, with no incident_person row: restricted to everyone (security review M2). */
const RESTRICTED = randomUUID();
/** Fixed dates, so the tests do not depend on the clock (UK midnight, the 1st of the month). */
const DAY = "2026-10-15";
const PERIOD = `from=${DAY}&to=${DAY}`;

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
       VALUES ($1, $3, 'medication', '2026-10-15T18:00:00Z', 'Evening dose given late', $4, $5),
              ($2, $3, 'fall', '2026-10-15T17:00:00Z', 'Slipped in the lounge', $4, $5),
              ($6, $3, 'medication', '2026-10-15T16:00:00Z', 'Dose missed', $4, $5),
              ($7, $3, 'medication', '2026-10-15T15:00:00Z', 'Dose dropped', $4, $5)`,
      [INCIDENT, FALL, LOC, DEMO.users.carer.id, [ADA], CLOSED, RESTRICTED],
    );
    for (const incident of [INCIDENT, FALL, CLOSED]) {
      await c.query(
        `INSERT INTO incident_person (incident_id, kind, role, person_id)
         VALUES ($1, 'service_user', 'affected', $2)`,
        [incident, ADA],
      );
    }
    await c.query(
      `UPDATE incident SET status = 'closed', closed_at = '2026-10-16T09:00:00Z', closed_by = $2,
         closed_reason = 'Reviewed' WHERE id = $1`,
      [CLOSED, DEMO.users.manager.id],
    );
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
         source_reference, transcribed_by, transcribed_at, tags, cd_schedule)
       VALUES ($1, $2, $1, 1, 'transcribed', '90000011000001104', 'Lorazepam 1mg tablets',
         '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', '2026-10-01T09:00:00Z',
         'prescription', 'Prescription, 01/11/2026', $3, '2026-10-01T09:00:00Z',
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
         '26643006', 'Oral', 'when_required', 'Dr A Example', '2026-10-01T09:00:00Z',
         'prescription', 'Prescription, 01/11/2026', $3, '2026-10-01T09:00:00Z',
         '{"kind": "amount", "quantity": 1, "unitCode": "428673006", "unitName": "tablet"}'::jsonb,
         'Pain')`,
      [PRN_ENTRY, ADA, DEMO.users.manager.id],
    );
    await c.query(
      `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome, quantity,
         unit_code, given_at, recorded_by, flags)
       VALUES ($1, $2, $3, '2026-10-15T07:00:00Z', 'given', 1, '428673006', '2026-10-15T07:05:00Z', $4,
         ARRAY['competence_override'])`,
      [DOSE, ADA, CD_ENTRY, DEMO.users.carer.id],
    );
    for (const hours of [10, 12]) {
      await c.query(
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, quantity,
           unit_code, given_at, recorded_by)
         VALUES ($5, $1, $2, 'given', 1, '428673006', '2026-10-15T00:00:00Z'::timestamptz + make_interval(hours => $3), $4)`,
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
    expect(r.status).toBe(403);
  });

  it("refuses a restricted incident whole: no read, add or change, and no record in the body", async () => {
    const read = await send("manager", `/v1/incidents/${RESTRICTED}/medication-error`);
    expect(read.status).toBe(403);
    expect(await read.text()).not.toMatch(/Dose dropped|kinds/);
    const add = await send("manager", `/v1/incidents/${RESTRICTED}/medication-error`, {
      method: "POST",
      body: { ...blank, personId: ADA },
    });
    expect(add.status).toBe(403);
    const change = await send("manager", `/v1/incidents/${RESTRICTED}/medication-error`, {
      method: "PATCH",
      body: { ...blank, version: 1 },
    });
    expect(change.status).toBe(403);
  });

  it("refuses details on a closed incident", async () => {
    const r = await send("manager", `/v1/incidents/${CLOSED}/medication-error`, {
      method: "POST",
      body: { ...blank, personId: ADA },
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toMatch(/closed/);
  });

  it("keeps the safeguarding prompt for an unsure answer, and clears it on a latest yes or no", async () => {
    const promptsNow = async () =>
      (
        await json<{ error: ErrorOut }>(
          await send("manager", `/v1/incidents/${INCIDENT}/medication-error`),
        )
      ).error.prompts.map((p) => p.prompt);
    const answer = (value: string, at: string) =>
      asDemo((c) =>
        c.query(
          `INSERT INTO classifier_answer (incident_id, question_key, value, answered_at)
           VALUES ($1, 'safeguarding.concern', to_jsonb($2::text), $3)`,
          [INCIDENT, value, at],
        ),
      );
    await answer("no", "2026-10-15T19:00:00Z");
    await answer("unsure", "2026-10-15T20:00:00Z");
    expect(await promptsNow()).toContain("safeguarding_consideration");
    await answer("no", "2026-10-15T21:00:00Z");
    expect(await promptsNow()).not.toContain("safeguarding_consideration");
  });

  it("counts it in the trend by month, kind and stage, leaving out deleted incidents", async () => {
    await asDemo(async (c) => {
      await c.query(
        `INSERT INTO medication_error (incident_id, person_id, kinds) VALUES ($1, $2, '{wrong_dose}')`,
        [CLOSED, ADA],
      );
      await c.query("UPDATE incident SET deleted_at = now() WHERE id = $1", [CLOSED]);
    });
    const r = await json<{
      months: {
        month: string;
        errors: number;
        notYetKnown: number;
        byKind: Record<string, number>;
      }[];
    }>(
      await send(
        "manager",
        `/v1/locations/${LOC}/medication-errors/trend?from=2026-09-01&to=2026-10-31`,
      ),
    );
    expect(r.months.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
    expect(r.months[0]?.errors).toBe(0);
    expect(r.months[1]?.errors).toBe(1);
    expect(r.months[1]?.notYetKnown).toBe(0);
    expect(r.months[1]?.byKind.wrong_time).toBe(1);
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
    expect(ada?.status).toBe("not_booked");
    expect(ada?.nextFrom).toBe("interval");
  });

  it("moves and cancels a booked review only with a reason", async () => {
    const made = await json<{ id: string; version: number }>(
      await send("manager", `/v1/people/${ADA}/medication-reviews`, {
        method: "POST",
        body: { dueOn: ukIsoDate(new Date(Date.now() + 30 * 86_400_000)) },
      }),
    );
    const noReason = await send("manager", `/v1/medication-reviews/${made.id}/reschedule`, {
      method: "POST",
      body: { dueOn: ukIsoDate(new Date(Date.now() + 40 * 86_400_000)), version: made.version },
    });
    expect(noReason.status).toBe(422);
    const moved = await send("manager", `/v1/medication-reviews/${made.id}/reschedule`, {
      method: "POST",
      body: {
        dueOn: ukIsoDate(new Date(Date.now() + 40 * 86_400_000)),
        reason: "GP surgery asked to move it",
        version: made.version,
      },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    const after = await json<{ version: number }>(moved);
    const cancelled = await send("manager", `/v1/medication-reviews/${made.id}/cancel`, {
      method: "POST",
      body: { reason: "Booked twice", version: after.version },
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const doneAgain = await send("manager", `/v1/medication-reviews/${reviewId}/reschedule`, {
      method: "POST",
      body: { dueOn: ukIsoDate(new Date()), reason: "Wrong", version },
    });
    expect(doneAgain.status).toBe(422);
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
  it("counts competence overrides against the member who gave the dose", async () => {
    const r = await json<{
      items: { memberId: string; competenceOverride: number; givenBeforeRecorded: number }[];
    }>(await send("manager", `/v1/locations/${LOC}/medicines/override-report?${PERIOD}`));
    expect(r.items.find((i) => i.memberId === DEMO.users.carer.id)?.competenceOverride).toBe(1);
  });

  it("counts PRN and psychotropic doses per person, with its note", async () => {
    const r = await json<{
      note: string;
      items: { personId: string; prnGiven: number; psychotropicGiven: number }[];
    }>(await send("manager", `/v1/locations/${LOC}/medicines/prn-report?${PERIOD}`));
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
      (await send("carer", `/v1/locations/${LOC}/medicines/prn-report?${PERIOD}`)).status,
    ).toBe(403);
    const long = await send(
      "manager",
      `/v1/locations/${LOC}/medicines/prn-report?from=2024-01-01&to=2026-10-15`,
    );
    expect(long.status).toBe(422);
    expect(JSON.stringify(await long.json())).toMatch(/days or fewer/);
  });
});
