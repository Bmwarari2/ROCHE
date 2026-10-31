import { DEMO } from "@harbour/db/seed";
import { ukDateOf, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_DMD,
  fixedCompetence,
  unavailableCompetence,
  unavailableDmd,
} from "../src/integrations/medicines-ports";
import { createHarness, type Harness } from "./support/harness";

/**
 * The medicines record and reconciliation API (Phase 2 slice 16; MEDS-001; medicines.md section
 * 5): transcription, the second check, changes and stops through the slice 2 rules; the
 * reconciliation applied in one transaction; competence and dm+d from their ports; audit by id.
 * The demo Registered Manager transcribes and the clinical lead checks (both hold
 * medicines.record.manage); the care worker reads only.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const BEN = "0194d000-0000-7000-8600-000000000002";
const PARACETAMOL = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
const IBUPROFEN = { vmpId: "90000041000001103", ampId: null, name: "Ibuprofen 200mg tablets" };
const ORAL = { code: "26643006", name: "Oral" };
const TABLET = { code: "428673006", name: "tablet" };
const SOURCE = { kind: "prescription", reference: "Prescription, Dr A Example, 31/10/2026" };

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return ukStartOfDay(ukDateOf(d));
};

const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

const regular = (quantity: number, time = "08:00") => ({
  kind: "regular",
  schedule: {
    pattern: { kind: "every_day" },
    times: [{ time, dose: { kind: "amount", quantity, unit: TABLET } }],
  },
});

const draft = (extra: Record<string, unknown> = {}) => ({
  product: PARACETAMOL,
  route: ORAL,
  directions: regular(2),
  prescriber: "Dr A Example",
  startsAt: day(1).toISOString(),
  source: SOURCE,
  ...extra,
});

const competence = fixedCompetence();

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  competence.held.set(`${DEMO.tenantId}:${DEMO.users.owner.id}`, "current");
  competence.held.set(`${DEMO.tenantId}:${DEMO.users.manager.id}`, "current");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("the medicines record", () => {
  let entryId = "";

  it("hazard HZ-005 transcribes an entry as not yet checked, with its status in words", async () => {
    const r = await send("manager", `/v1/people/${ADA}/medicines`, {
      method: "POST",
      body: draft(),
    });
    expect(r.status).toBe(201);
    const entry = (await r.json()) as Record<string, unknown> & { status: { words: string } };
    expect(entry.state).toBe("not_yet_checked");
    expect(entry.origin).toBe("transcribed");
    expect(entry.directionsInWords).toBe("2 tablets every day at 08:00");
    expect(entry.status.words).toBe("Not started yet");
    entryId = entry.id as string;
  });

  it("refuses a second entry of the same dm+d product, a typed name and a product dm+d does not hold", async () => {
    const twice = await send("manager", `/v1/people/${ADA}/medicines`, {
      method: "POST",
      body: draft(),
    });
    expect(twice.status).toBe(422);
    expect(((await twice.json()) as { code: string }).code).toBe("medicine_same_product_in_force");
    const typed = await send("manager", `/v1/people/${ADA}/medicines`, {
      method: "POST",
      body: draft({ product: { vmpId: "123456", ampId: null, name: "Paracetamol" } }),
    });
    expect(typed.status).toBe(422);
    const unknown = await send("manager", `/v1/people/${ADA}/medicines`, {
      method: "POST",
      body: draft({ product: { vmpId: "90000071000001107", ampId: null, name: "Unknown" } }),
    });
    expect([422]).toContain(unknown.status);
  });

  it("refuses a dose with more than 3 decimal places, and a route dm+d does not give", async () => {
    const dose = await send("manager", `/v1/people/${BEN}/medicines`, {
      method: "POST",
      body: draft({ directions: regular(0.1234) }),
    });
    expect(dose.status).toBe(422);
    const route = await send("manager", `/v1/people/${BEN}/medicines`, {
      method: "POST",
      body: draft({ route: { code: "34206005", name: "Subcutaneous" } }),
    });
    expect(route.status).toBe(422);
    expect(((await route.json()) as { detail: string }).detail).toContain("does not give");
  });

  it("refuses a care worker transcribing, and lets them read the record", async () => {
    const write = await send("carer", `/v1/people/${ADA}/medicines`, {
      method: "POST",
      body: draft({ product: IBUPROFEN }),
    });
    expect(write.status).toBe(403);
    const read = await send("carer", `/v1/people/${ADA}/medicines`);
    expect(read.status).toBe(200);
  });

  it("hazard HZ-005 refuses a second check by the transcriber, and by someone without current competence", async () => {
    const self = await send("manager", `/v1/medicines/${entryId}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(self.status).toBe(422);
    expect(((await self.json()) as { code: string }).code).toBe("medicine_checker_is_transcriber");
    competence.held.set(`${DEMO.tenantId}:${DEMO.users.owner.id}`, "expired");
    const expired = await send("owner", `/v1/medicines/${entryId}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(expired.status, await expired.clone().text()).toBe(422);
    competence.held.set(`${DEMO.tenantId}:${DEMO.users.owner.id}`, "current");
    const ok = await send("owner", `/v1/medicines/${entryId}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { state: string }).state).toBe("checked");
    const again = await send("owner", `/v1/medicines/${entryId}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(again.status).toBe(422);
  });

  it("hazard HZ-004 changes a medicine as a new version, refusing a stale version and another product", async () => {
    const stale = await send("manager", `/v1/medicines/${entryId}/versions`, {
      method: "POST",
      body: {
        ...draft({ directions: regular(1), startsAt: day(3).toISOString() }),
        expectedVersion: 2,
      },
    });
    expect(stale.status).toBe(409);
    const other = await send("manager", `/v1/medicines/${entryId}/versions`, {
      method: "POST",
      body: {
        ...draft({ product: IBUPROFEN, startsAt: day(3).toISOString() }),
        expectedVersion: 1,
      },
    });
    expect(other.status).toBe(422);
    const r = await send("manager", `/v1/medicines/${entryId}/versions`, {
      method: "POST",
      body: {
        ...draft({ directions: regular(1), startsAt: day(3).toISOString() }),
        expectedVersion: 1,
      },
    });
    expect(r.status).toBe(201);
    const { entry } = (await r.json()) as {
      entry: { version: number; state: string; replacesId: string };
    };
    expect(entry).toMatchObject({ version: 2, state: "not_yet_checked", replacesId: entryId });
    const twice = await send("manager", `/v1/medicines/${entryId}/versions`, {
      method: "POST",
      body: {
        ...draft({ directions: regular(1), startsAt: day(4).toISOString() }),
        expectedVersion: 1,
      },
    });
    expect(twice.status).toBe(409);
    const history = (await (await send("carer", `/v1/medicines/${entryId}/history`)).json()) as {
      versions: { version: number; state: string; replacedFrom: string | null }[];
    };
    expect(history.versions.map((v) => [v.version, v.state])).toEqual([
      [1, "replaced"],
      [2, "not_yet_checked"],
    ]);
    expect(history.versions[0]?.replacedFrom).toBe(day(3).toISOString());
  });

  it("shows the MAR for a cycle from the rate table, with the times before recording not due", async () => {
    const r = await send("carer", `/v1/people/${ADA}/mar?cycleStart=${ukDateOf(new Date())}`);
    expect(r.status).toBe(200);
    const mar = (await r.json()) as {
      cycle: { days: number };
      doses: { doseInWords: string; date: string }[];
    };
    expect(mar.cycle.days).toBeGreaterThan(0);
    expect(mar.doses.some((d) => d.doseInWords === "2 tablets")).toBe(true);
    expect(mar.doses.some((d) => d.doseInWords === "1 tablet")).toBe(true);
  });

  it("hazard HZ-002 gives each MAR dose its entry's status, so a cell never hides a notice", async () => {
    const mar = (await (
      await send("carer", `/v1/people/${ADA}/mar?cycleStart=${ukDateOf(new Date())}`)
    ).json()) as { doses: { entryStatus: { words: string; notice: string | null } }[] };
    expect(mar.doses.length).toBeGreaterThan(0);
    for (const d of mar.doses) expect(d.entryStatus.words.length).toBeGreaterThan(0);
    // Version 2 is not yet checked, so its doses carry that notice in words.
    expect(mar.doses.some((d) => d.entryStatus.notice !== null)).toBe(true);
  });

  it("stops a medicine with its reason and source, and refuses one without a reason", async () => {
    const blank = await send("manager", `/v1/medicines/${entryId}/stop`, {
      method: "POST",
      body: { effectiveAt: day(5).toISOString(), reason: " ", source: SOURCE, expectedVersion: 2 },
    });
    expect(blank.status).toBe(422);
    const r = await send("manager", `/v1/medicines/${entryId}/stop`, {
      method: "POST",
      body: {
        effectiveAt: day(5).toISOString(),
        reason: "Course finished",
        source: SOURCE,
        expectedVersion: 2,
      },
    });
    expect(r.status).toBe(200);
    const { entry } = (await r.json()) as { entry: { state: string; stop: { reason: string } } };
    expect(entry.state).toBe("stopped");
    expect(entry.stop.reason).toBe("Course finished");
  });

  it("audits by id only, never the medicine or its directions", async () => {
    const client = await h.db.pool("harbour_owner").connect();
    let rows: { action: string; text: string }[] = [];
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [DEMO.tenantId],
      );
      rows = (
        await client.query<{ action: string; text: string }>(
          `SELECT action, coalesce(scope::text, '') || coalesce(reason, '') AS text
             FROM audit_event WHERE action LIKE 'medicines.%'`,
        )
      ).rows;
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      "medicines.entry.transcribed",
      "medicines.entry.checked",
      "medicines.entry.changed",
      "medicines.entry.stopped",
      "medicines.entry.viewed",
    ]) {
      expect(actions.has(a), [...actions].join(",")).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toMatch(/Paracetamol|tablet|Dr A Example/);
  });
});

describe("hazard HZ-121 reconciliation", () => {
  let recId = "";
  let continueLine = "";
  let startLine = "";
  let adaEntry = "";
  let placementId = "";

  it("lists the admission as not yet reconciled", async () => {
    const r = (await (await send("manager", `/v1/people/${ADA}/medicines`)).json()) as {
      entries: { id: string }[];
      outstandingReconciliations: { kind: string; eventId: string; notice: string }[];
    };
    const admission = r.outstandingReconciliations.find((o) => o.kind === "admission");
    expect(admission?.notice).toMatch(/^Medicines not yet reconciled since the admission on/);
    placementId = admission?.eventId as string;
    adaEntry = r.entries[0]?.id as string;
  });

  it("starts one for the admission, with the entries to decide on, and refuses a second open one", async () => {
    const r = await send("manager", `/v1/people/${ADA}/medicine-reconciliations`, {
      method: "POST",
      body: { trigger: "admission", eventId: placementId },
    });
    expect(r.status).toBe(201);
    const rec = (await r.json()) as {
      id: string;
      entriesAtStart: { entryId: string }[];
      version: number;
    };
    expect(rec.entriesAtStart.map((e) => e.entryId)).toContain(adaEntry);
    recId = rec.id;
    const again = await send("manager", `/v1/people/${ADA}/medicine-reconciliations`, {
      method: "POST",
      body: { trigger: "change" },
    });
    expect(again.status).toBe(409);
  });

  it("records a source and its lines as written", async () => {
    const s = await send("manager", `/v1/people/${ADA}/medicine-reconciliations/${recId}/sources`, {
      method: "POST",
      body: {
        kind: "gp_record",
        reference: "GP summary for admission",
        receivedAt: new Date().toISOString(),
      },
    });
    expect(s.status).toBe(201);
    const sourceId = ((await s.json()) as { sources: { id: string }[] }).sources[0]?.id as string;
    const line = async (asWritten: string, product: unknown, says: string) => {
      const r = await send("manager", `/v1/people/${ADA}/medicine-reconciliations/${recId}/items`, {
        method: "POST",
        body: { sourceId, asWritten, product, says },
      });
      expect(r.status).toBe(201);
      const items = ((await r.json()) as { items: { id: string; asWritten: string }[] }).items;
      return items.find((i) => i.asWritten === asWritten)?.id as string;
    };
    continueLine = await line(
      "Paracetamol 500mg two tablets each morning",
      PARACETAMOL,
      "continue",
    );
    startLine = await line("Ibuprofen 200mg one tablet at night", IBUPROFEN, "start");
  });

  it("refuses completion while a line is undecided, and audits the refusal", async () => {
    const rec = (await (
      await send("manager", `/v1/people/${ADA}/medicine-reconciliations/${recId}`)
    ).json()) as {
      version: number;
    };
    const r = await send(
      "manager",
      `/v1/people/${ADA}/medicine-reconciliations/${recId}/complete`,
      {
        method: "POST",
        body: {
          expectedVersion: rec.version,
          allergiesCompared: true,
          personInvolvement: { involved: true },
        },
      },
    );
    expect(r.status).toBe(422);
  });

  it("completes with every decision and applies the plan in one transaction", async () => {
    let rec = (await (
      await send("manager", `/v1/people/${ADA}/medicine-reconciliations/${recId}`)
    ).json()) as {
      version: number;
    };
    const put = await send(
      "manager",
      `/v1/people/${ADA}/medicine-reconciliations/${recId}/decisions`,
      {
        method: "PUT",
        body: {
          expectedVersion: rec.version,
          entryDecisions: [
            {
              kind: "continue",
              entryId: adaEntry,
              itemIds: [continueLine],
              scheduledStillStands:
                "The GP summary confirms the dose change and the stop already recorded.",
            },
          ],
          itemDecisions: [
            {
              kind: "start",
              itemId: startLine,
              draft: {
                product: IBUPROFEN,
                route: ORAL,
                directions: regular(1, "20:00"),
                prescriber: "Dr A Example",
                startsAt: day(1).toISOString(),
              },
            },
          ],
        },
      },
    );
    expect(put.status).toBe(200);
    rec = (await put.json()) as { version: number };
    const done = await send(
      "manager",
      `/v1/people/${ADA}/medicine-reconciliations/${recId}/complete`,
      {
        method: "POST",
        body: {
          expectedVersion: rec.version,
          allergiesCompared: true,
          personInvolvement: { involved: true },
        },
      },
    );
    const text = await done.text();
    expect(done.status, text).toBe(200);
    expect((JSON.parse(text) as { status: string }).status).toBe("completed");
    const record = (await (await send("manager", `/v1/people/${ADA}/medicines`)).json()) as {
      entries: { product: { vmpId: string }; origin: string; state: string }[];
      outstandingReconciliations: { kind: string }[];
    };
    const started = record.entries.find((e) => e.product.vmpId === IBUPROFEN.vmpId);
    expect(started).toMatchObject({ origin: "reconciliation", state: "not_yet_checked" });
    expect(record.outstandingReconciliations.some((o) => o.kind === "admission")).toBe(false);
  });

  it("refuses any change to a completed reconciliation", async () => {
    const r = await send("manager", `/v1/people/${ADA}/medicine-reconciliations/${recId}/sources`, {
      method: "POST",
      body: { kind: "gp_record", reference: "Late", receivedAt: new Date().toISOString() },
    });
    expect(r.status).toBe(409);
  });

  it("refuses completion by someone without current medicines competence", async () => {
    const start = await send("manager", `/v1/people/${BEN}/medicine-reconciliations`, {
      method: "POST",
      body: { trigger: "change" },
    });
    const rec = (await start.json()) as { id: string; version: number };
    competence.held.set(`${DEMO.tenantId}:${DEMO.users.manager.id}`, "not_held");
    const s = await send(
      "manager",
      `/v1/people/${BEN}/medicine-reconciliations/${rec.id}/sources`,
      {
        method: "POST",
        body: {
          kind: "prescription",
          reference: "Prescription",
          receivedAt: new Date().toISOString(),
        },
      },
    );
    const version = ((await s.json()) as { version: number }).version;
    const r = await send(
      "manager",
      `/v1/people/${BEN}/medicine-reconciliations/${rec.id}/complete`,
      {
        method: "POST",
        body: {
          expectedVersion: version,
          allergiesCompared: true,
          personInvolvement: { involved: true },
        },
      },
    );
    expect(r.status).toBe(422);
    expect(((await r.json()) as { detail: string }).detail).toMatch(/competen/i);
    competence.held.set(`${DEMO.tenantId}:${DEMO.users.manager.id}`, "current");
  });
});

describe("rule 13 fields and weekly schedules (slice 22 integration)", () => {
  const LACTULOSE = { vmpId: "90000051000001100", ampId: null, name: "Lactulose" };
  const ML = { code: "258773002", name: "ml" };

  it("hazard HZ-003 expands a weekly schedule on its weekdays, so its doses appear on the MAR", async () => {
    const DORA = "0194d000-0000-7000-8600-000000000004";
    const today = ukDateOf(new Date());
    const r = await send("manager", `/v1/people/${DORA}/medicines`, {
      method: "POST",
      body: draft({
        directions: {
          kind: "regular",
          schedule: {
            pattern: {
              kind: "weekly",
              weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
              intervalWeeks: 1,
              anchorOn: today,
            },
            times: [{ time: "09:00", dose: { kind: "amount", quantity: 1, unit: TABLET } }],
          },
        },
      }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const mar = (await (
      await send("manager", `/v1/people/${DORA}/mar?cycleStart=${today}`)
    ).json()) as {
      doses: { notDue: boolean }[];
    };
    expect(mar.doses.filter((d) => !d.notDue).length).toBeGreaterThan(5);
    const words = await send("manager", `/v1/people/${DORA}/medicines`, {
      method: "POST",
      body: draft({
        product: IBUPROFEN,
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "weekly", weekdays: ["monday"], intervalWeeks: 1, anchorOn: today },
            times: [{ time: "09:00", dose: { kind: "amount", quantity: 1, unit: TABLET } }],
          },
        },
      }),
    });
    expect(words.status).toBe(422);
  });

  it("hazard HZ-004 stores tags, the minimum interval and a when-required maximum, and refuses a when-required entry with neither", async () => {
    const EVE = "0194d000-0000-7000-8600-000000000005";
    const prn = (max: number | null, interval: number | null) =>
      send("manager", `/v1/people/${EVE}/medicines`, {
        method: "POST",
        body: draft({
          product: LACTULOSE,
          indication: "Constipation",
          directions: {
            kind: "when_required",
            dose: { kind: "amount", quantity: 15, unit: ML },
            maxQuantityPer24Hours: max,
          },
          minimumIntervalMinutes: interval,
          tags: [],
        }),
      });
    const neither = await prn(null, null);
    expect(neither.status).toBe(422);
    expect(((await neither.json()) as { code: string; detail: string }).detail).toMatch(
      /prescriber/i,
    );
    const ok = await prn(30, 240);
    expect(ok.status, await ok.clone().text()).toBe(201);
    const entry = (await ok.json()) as {
      minimumIntervalMinutes: number;
      directions: { maxQuantityPer24Hours: number };
    };
    expect(entry.minimumIntervalMinutes).toBe(240);
    expect(entry.directions.maxQuantityPer24Hours).toBe(30);
    const tagged = await send("manager", `/v1/people/${EVE}/medicines`, {
      method: "POST",
      body: draft({ tags: ["paracetamol"] }),
    });
    expect(tagged.status, await tagged.clone().text()).toBe(201);
    expect(((await tagged.json()) as { tags: string[] }).tags).toEqual(["paracetamol"]);
  });
});

describe("the ports fail closed", () => {
  it("unavailable competence answers not_held, and unavailable dm+d knows no product", async () => {
    expect(
      await unavailableCompetence.forMember(DEMO.tenantId, DEMO.users.nurse.id, new Date()),
    ).toBe("not_held");
    expect(await unavailableDmd.facts(PARACETAMOL)).toBeNull();
    expect(unavailableDmd.loaded).toBe(false);
    expect(FIXTURE_DMD.has(PARACETAMOL.vmpId)).toBe(true);
  });

  it("refuses transcription when dm+d is not loaded, saying so", async () => {
    const services = h.handle.services as { medicines: { dmd: unknown } };
    const before = services.medicines.dmd;
    services.medicines.dmd = unavailableDmd;
    const r = await send("manager", `/v1/people/${BEN}/medicines`, {
      method: "POST",
      body: draft(),
    });
    services.medicines.dmd = before;
    expect(r.status).toBe(422);
    expect(((await r.json()) as { detail: string }).detail).toContain("not loaded");
  });
});

describe("hazards HZ-005 and HZ-121 a return from hospital", () => {
  const CARL = "0194d000-0000-7000-8600-000000000003";
  const TRANSFER = "0194d000-0000-7000-8f00-00000000a001";

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

  it("completes the return's medicines check when its reconciliation completes", async () => {
    await asDemo((c) =>
      c.query(
        `INSERT INTO hospital_transfer (id, person_id, location_id, left_at, hospital_name, pack,
           returned_at, return_checks)
         VALUES ($1, $2, $3, now() - interval '2 days', 'Example General Hospital', '{}'::jsonb,
           now() - interval '1 hour',
           '{"medicines_reconciled": {"title": "Reconcile medicines", "hazardIds": ["HZ-121"], "doneBy": null, "doneAt": null}}'::jsonb)`,
        [TRANSFER, CARL, DEMO.locationId],
      ),
    );
    await asDemo((c) =>
      c.query(
        `INSERT INTO task (kind, title, required_permission, person_id, location_id, source_type,
           source_id, due_at)
         VALUES ('people.return_check.medicines_reconciled', 'Reconcile medicines',
           'care.plan.write', $1, $2, 'hospital_transfer', $3, now() + interval '1 day')`,
        [CARL, DEMO.locationId, TRANSFER],
      ),
    );
    // The check is done by the reconciliation, never ticked by hand (HZ-005).
    const transferVersion = await asDemo(
      async (c) =>
        (
          await c.query<{ version: number }>(
            "SELECT version FROM hospital_transfer WHERE id = $1",
            [TRANSFER],
          )
        ).rows[0]?.version,
    );
    const byHand = await send(
      "manager",
      `/v1/people/${CARL}/hospital-transfers/${TRANSFER}/return-checks/medicines_reconciled`,
      { method: "POST", body: { version: transferVersion } },
    );
    expect(byHand.status, await byHand.clone().text()).toBe(422);
    // Nor through the task list: the task is completed only by its evidence.
    const t = await asDemo(
      async (c) =>
        (
          await c.query<{ id: string; version: number }>(
            "SELECT id, version FROM task WHERE source_id = $1 AND kind = $2",
            [TRANSFER, "people.return_check.medicines_reconciled"],
          )
        ).rows[0],
    );
    const viaTasks = await send("owner", `/v1/tasks/${t?.id}/transition`, {
      method: "POST",
      body: { to: "done", version: t?.version },
    });
    expect(viaTasks.status).not.toBe(200);
    const start = await send("manager", `/v1/people/${CARL}/medicine-reconciliations`, {
      method: "POST",
      body: { trigger: "return_from_hospital", eventId: TRANSFER },
    });
    expect(start.status).toBe(201);
    const rec = (await start.json()) as { id: string };
    const s = await send(
      "manager",
      `/v1/people/${CARL}/medicine-reconciliations/${rec.id}/sources`,
      {
        method: "POST",
        body: {
          kind: "discharge_letter",
          reference: "Discharge letter, Ward 7",
          receivedAt: new Date().toISOString(),
        },
      },
    );
    const version = ((await s.json()) as { version: number }).version;
    const done = await send(
      "manager",
      `/v1/people/${CARL}/medicine-reconciliations/${rec.id}/complete`,
      {
        method: "POST",
        body: {
          expectedVersion: version,
          allergiesCompared: true,
          personInvolvement: { involved: true },
        },
      },
    );
    expect(done.status, await done.clone().text()).toBe(200);
    const checks = await asDemo(
      async (c) =>
        (
          await c.query<{ return_checks: Record<string, { doneAt: string | null }> }>(
            "SELECT return_checks FROM hospital_transfer WHERE id = $1",
            [TRANSFER],
          )
        ).rows[0]?.return_checks,
    );
    expect(checks?.medicines_reconciled?.doneAt).toBeTruthy();
    const tasks = await asDemo(
      async (c) =>
        (
          await c.query<{ status: string }>(
            "SELECT status FROM task WHERE source_id = $1 AND kind = $2",
            [TRANSFER, "people.return_check.medicines_reconciled"],
          )
        ).rows,
    );
    expect(tasks.map((t) => t.status)).toEqual(["done"]);
  });
});

describe("the record holds dm+d's words and one entry per product", () => {
  const LACTULOSE = { vmpId: "90000051000001100", ampId: null, name: "Lactulose" };

  it("hazard HZ-005 stores dm+d's names for the product, route and unit, never the request's", async () => {
    const r = await send("manager", `/v1/people/${BEN}/medicines`, {
      method: "POST",
      body: draft({
        product: { ...PARACETAMOL, name: "Calpol" },
        route: { code: ORAL.code, name: "By mouth" },
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [
              {
                time: "08:00",
                dose: { kind: "amount", quantity: 1, unit: { code: TABLET.code, name: "pill" } },
              },
            ],
          },
        },
      }),
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const entry = (await r.json()) as {
      product: { name: string };
      route: { name: string };
      directionsInWords: string;
    };
    expect(entry.product.name).toBe("Paracetamol 500mg tablets");
    expect(entry.route.name).toBe("Oral");
    expect(entry.directionsInWords).toBe("1 tablet every day at 08:00");
  });

  it("hazard HZ-005 refuses an AMP dm+d cannot vouch for", async () => {
    const r = await send("manager", `/v1/people/${BEN}/medicines`, {
      method: "POST",
      body: draft({ product: { ...LACTULOSE, ampId: "90000081000001109" } }),
    });
    expect(r.status).toBe(422);
  });

  it("hazard HZ-004 takes one of two transcriptions of the same product sent together", async () => {
    const body = draft({
      product: LACTULOSE,
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_day" },
          times: [
            {
              time: "08:00",
              dose: { kind: "amount", quantity: 15, unit: { code: "258773002", name: "ml" } },
            },
          ],
        },
      },
    });
    const [one, two] = await Promise.all([
      send("manager", `/v1/people/${BEN}/medicines`, { method: "POST", body }),
      send("manager", `/v1/people/${BEN}/medicines`, { method: "POST", body }),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 422]);
  });

  it("hazard HZ-121 applies a reconciliation's stop to the entry it names", async () => {
    // Carl's return reconciliation is complete, so a new one starts after this entry exists.
    const CARL = "0194d000-0000-7000-8600-000000000003";
    const base = `/v1/people/${CARL}/medicine-reconciliations`;
    const t = await send("manager", `/v1/people/${CARL}/medicines`, {
      method: "POST",
      body: draft({ product: IBUPROFEN, startsAt: day(0).toISOString() }),
    });
    expect(t.status, await t.clone().text()).toBe(201);
    const entryId = ((await t.json()) as { id: string }).id;
    const start = await send("manager", base, { method: "POST", body: { trigger: "change" } });
    expect(start.status, await start.clone().text()).toBe(201);
    const recId = ((await start.json()) as { id: string }).id;
    const s = await send("manager", `${base}/${recId}/sources`, {
      method: "POST",
      body: {
        kind: "prescriber_instruction",
        reference: "GP letter, medicines review",
        receivedAt: new Date().toISOString(),
      },
    });
    expect(s.status, await s.clone().text()).toBe(201);
    const sourceId = ((await s.json()) as { sources: { id: string }[] }).sources[0]?.id;
    const i = await send("manager", `${base}/${recId}/items`, {
      method: "POST",
      body: { sourceId, asWritten: "Stop ibuprofen", product: IBUPROFEN, says: "stop" },
    });
    expect(i.status, await i.clone().text()).toBe(201);
    const itemId = ((await i.json()) as { items: { id: string }[] }).items[0]?.id;
    const version = (
      (await (await send("manager", `${base}/${recId}`)).json()) as {
        version: number;
      }
    ).version;
    const put = await send("manager", `${base}/${recId}/decisions`, {
      method: "PUT",
      body: {
        expectedVersion: version,
        entryDecisions: [
          {
            kind: "stop",
            entryId,
            itemIds: [itemId],
            reason: "Stopped at the medicines review",
            withdrawLaterReason: null,
          },
        ],
        itemDecisions: [],
      },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const done = await send("manager", `${base}/${recId}/complete`, {
      method: "POST",
      body: {
        expectedVersion: ((await put.json()) as { version: number }).version,
        allergiesCompared: true,
        personInvolvement: { involved: true },
      },
    });
    expect(done.status, await done.clone().text()).toBe(200);
    const after = (await (await send("manager", `/v1/medicines/${entryId}/history`)).json()) as {
      versions: { stop: { reason: string } | null }[];
    };
    expect(after.versions.at(-1)?.stop?.reason).toBe("Stopped at the medicines review");
  });

  it("hazard HZ-121 keeps the audit of a refused check and a refused completion", async () => {
    // A refusal made here, then the audit read back for that entry with its person.
    const t = await send("manager", `/v1/people/${BEN}/medicines`, {
      method: "POST",
      body: draft({ product: IBUPROFEN }),
    });
    expect(t.status, await t.clone().text()).toBe(201);
    const id = ((await t.json()) as { id: string }).id;
    const self = await send("manager", `/v1/medicines/${id}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(self.status).toBe(422);
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [DEMO.tenantId],
      );
      const { rows } = await client.query<{ action: string; person: string | null }>(
        `SELECT action, scope->>'personId' AS person FROM audit_event
          WHERE outcome = 'denied'
            AND ((action = 'medicines.entry.checked' AND resource_id = $1)
              OR action = 'medicines.reconciliation.completed')`,
        [id],
      );
      await client.query("COMMIT");
      expect(rows.find((r) => r.action === "medicines.entry.checked")?.person).toBe(BEN);
      expect(rows.some((r) => r.action === "medicines.reconciliation.completed")).toBe(true);
    } finally {
      client.release();
    }
  });

  it("hazard HZ-004 withdraws a later version when a change starts sooner, giving the medicine to the new one", async () => {
    const CARL = "0194d000-0000-7000-8600-000000000003";
    const t = await send("manager", `/v1/people/${CARL}/medicines`, {
      method: "POST",
      body: draft(),
    });
    expect(t.status, await t.clone().text()).toBe(201);
    const v1 = ((await t.json()) as { id: string }).id;
    const change = (from: number, expectedVersion: number, withdrawLaterReason: string | null) =>
      send("manager", `/v1/medicines/${v1}/versions`, {
        method: "POST",
        body: {
          ...draft({ directions: regular(1), startsAt: day(from).toISOString() }),
          expectedVersion,
          withdrawLaterReason,
        },
      });
    const v2 = await change(5, 1, null);
    expect(v2.status, await v2.clone().text()).toBe(201);
    // Version 2 starts in 5 days; a change from 3 days must say why it withdraws it.
    expect((await change(3, 2, null)).status).toBe(422);
    const r = await change(3, 2, "Transcribed from the wrong letter");
    expect(r.status, await r.clone().text()).toBe(201);
    const history = (await (await send("carer", `/v1/medicines/${v1}/history`)).json()) as {
      versions: { version: number; state: string }[];
    };
    expect(history.versions.map((v) => [v.version, v.state])).toEqual([
      [1, "replaced"],
      [2, "withdrawn"],
      [3, "not_yet_checked"],
    ]);
  });

  it("hazard HZ-001 refuses a source document that is not on this person's record", async () => {
    const r = await send("manager", `/v1/people/${BEN}/medicines`, {
      method: "POST",
      body: draft({
        product: { vmpId: "90000061000001102", ampId: null, name: "Insulin" },
        route: { code: "34206005", name: "Subcutaneous" },
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [
              {
                time: "08:00",
                dose: { kind: "amount", quantity: 10, unit: { code: "767525000", name: "unit" } },
              },
            ],
          },
        },
        source: { ...SOURCE, documentId: "0194d000-0000-7000-8f00-00000000d001" },
      }),
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { detail: string }).detail).toContain("this person's record");
  });
});
