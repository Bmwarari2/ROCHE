import { randomUUID } from "node:crypto";
import { DEVICE_HEADER } from "@harbour/contracts";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { MEDICINES_RATE_KEYS, ukDateOf, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { escalateOutstandingDoses, outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, markSessionsVerified, PASSWORD } from "./support/harness";

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
    // A device the session was not already bound to does not make it an upload (re-review M1).
    expect((await record(randomUUID(), true)).status).toBe(422);
    // Bound now (the request above bound the session to it), the second record is kept, and a
    // resend finds the same conflict.
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
    // A further upload of the dose by the same person joins the open conflict (security H1), kept
    // with its own id so a resend finds it (re-review M4).
    const thirdId = randomUUID();
    const third = await record(thirdId, true);
    expect(third.status).toBe(202);
    expect((await json<{ conflictId: string }>(third)).conflictId).toBe(raised.conflictId);
    const thirdAgain = await record(thirdId, true);
    expect((await json<{ conflictId: string }>(thirdAgain)).conflictId).toBe(raised.conflictId);
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
        joined: { id: string }[];
        problems: string[];
      }[];
    }>(
      await send("manager", `/v1/medicine-administration-conflicts?locationId=${DEMO.locationId}`),
    );
    const shown = list.conflicts.find((x) => x.id === raised.conflictId);
    expect(shown?.standing.id).toBe(standingId);
    expect(shown?.uploaded.id).toBe(secondId);
    expect(shown?.problems.length).toBeGreaterThan(0);
    expect(shown?.joined.map((j) => j.id)).toEqual([thirdId]);
    expect(list.conflicts.filter((x) => x.uploaded.id === thirdId)).toEqual([]);

    const resolve = (body: Record<string, unknown>, who = "owner") =>
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
    // Every refusal is audited, the repeat included (security review L6).
    const refusals = await asDemo(
      async (c) =>
        (
          await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_event
              WHERE action = 'medicines.administration.conflict_resolved' AND outcome = 'denied'
                AND resource_id = $1`,
            [raised.conflictId],
          )
        ).rows[0]?.n,
    );
    expect(Number(refusals)).toBeGreaterThanOrEqual(2);
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
      "owner",
      `/v1/medicine-administration-conflicts/${next.conflictId}/resolve`,
      {
        method: "POST",
        body: { outcome: "both_given", correctionId: randomUUID(), note: "Given twice" },
      },
    );
    expect(twice.status).toBe(422);
    // A lone nurse decides on their own record, and the Registered Manager reviews it afterwards
    // (H-1270's recommended answer).
    const both = await send(
      "manager",
      `/v1/medicine-administration-conflicts/${next.conflictId}/resolve`,
      { method: "POST", body: { outcome: "both_given", note: "Given on both tablets" } },
    );
    expect(both.status, await both.clone().text()).toBe(200);
    const [retrospective] = await asDemo(
      async (c) =>
        (
          await c.query<{
            id: string;
            version: number;
            priority: string;
            assignee_role_key: string;
          }>(
            `SELECT id, version, priority, assignee_role_key FROM task
              WHERE kind = 'medicines.administration.conflict_retrospective' AND source_id = $1`,
            [next.conflictId],
          )
        ).rows,
    );
    // The manager decided, so the provider reviews; the decider cannot close the review (B1).
    expect(retrospective).toMatchObject({ priority: "routine", assignee_role_key: "owner" });
    const close = (who: string) =>
      send(who, `/v1/tasks/${retrospective?.id}/transition`, {
        method: "POST",
        body: { to: "done", version: retrospective?.version },
      });
    expect((await close("manager")).status).toBe(403);
    const reviewed = await close("owner");
    expect(reviewed.status, await reviewed.clone().text()).toBe(200);
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

  it("hazards HZ-004 and HZ-008 the decision must fit both records, a disagreement is urgent and the round says a review is waiting", async () => {
    const other = (
      await transcribe(BEN, {
        product: PARACETAMOL,
        directions: regularAt(ukTime(new Date(Date.now() + 5 * MINUTE))),
      })
    ).id;
    const dueOf = async (entryId: string) =>
      (
        await json<Round>(
          await send("manager", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`),
        )
      ).people
        .find((p) => p.personId === BEN)
        ?.doses.find((d) => d.entryId === entryId)?.dueAt;
    const record = (entryId: string, dueAt: string | undefined, outcome: string, device: boolean) =>
      send("manager", `/v1/people/${BEN}/medicine-administrations`, {
        method: "POST",
        headers: device ? { [DEVICE_HEADER]: DEVICE } : {},
        body: {
          id: randomUUID(),
          entryId,
          dueAt,
          outcome,
          ...(outcome === "given"
            ? { amount: { quantity: 1, unitCode: TABLET.code } }
            : { reason: { code: "declined", note: null } }),
          timingReason: "Given with breakfast",
          deviceOffsetMs: device ? 0 : null,
        },
      });
    const resolveAs = (conflictId: string, body: Record<string, unknown>) =>
      send("owner", `/v1/medicine-administration-conflicts/${conflictId}/resolve`, {
        method: "POST",
        body,
      });
    const priorityOf = async (conflictId: string) =>
      asDemo(
        async (c) =>
          (
            await c.query<{ priority: string }>(
              "SELECT priority FROM task WHERE kind = 'medicines.administration.conflict' AND source_id = $1",
              [conflictId],
            )
          ).rows[0]?.priority,
      );
    // The record that stands says refused; the device says given.
    const dueAt = await dueOf(other);
    const refusedFirst = await record(other, dueAt, "refused", false);
    expect(refusedFirst.status).toBe(201);
    const standingOf = (await json<{ administration: { id: string } }>(refusedFirst)).administration
      .id;
    const up = await record(other, dueAt, "given", true);
    expect(up.status, await up.clone().text()).toBe(202);
    const { conflictId } = await json<{ conflictId: string }>(up);
    expect(await priorityOf(conflictId)).toBe("urgent");
    const round = await json<{
      people: {
        personId: string;
        doses: { entryId: string; reviewPending: boolean; reviewInWords: string | null }[];
      }[];
    }>(await send("manager", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`));
    const shown = round.people
      .find((p) => p.personId === BEN)
      ?.doses.find((d) => d.entryId === other);
    expect(shown?.reviewPending).toBe(true);
    expect(shown?.reviewInWords).toMatch(/waiting for review/);
    const both = await resolveAs(conflictId, { outcome: "both_given", note: "Both given" });
    expect((await json<{ code: string }>(both)).code).toBe("conflict_not_both_given");
    const stands = await resolveAs(conflictId, { outcome: "first_stands", note: "Refused" });
    expect((await json<{ code: string }>(stands)).code).toBe("conflict_upload_says_given");
    // The uploader cannot correct someone else's record to their own (clinical re-review M4).
    const mine = await send(
      "manager",
      `/v1/medicine-administration-conflicts/${conflictId}/resolve`,
      { method: "POST", body: { outcome: "first_stands", note: "Mine" } },
    );
    expect(mine.status).toBe(422);
    // Corrected through the corrections route, the conflict is resolved naming the correction.
    const correctionId = randomUUID();
    const corrected = await send(
      "owner",
      `/v1/medicine-administrations/${standingOf}/corrections`,
      {
        method: "POST",
        body: {
          id: correctionId,
          correctionReason: "Recorded as refused in error: the device shows it was given",
          entryId: other,
          dueAt,
          outcome: "given",
          amount: { quantity: 1, unitCode: TABLET.code },
          timingReason: "Given with breakfast",
          givenAt: new Date().toISOString(),
        },
      },
    );
    expect(corrected.status, await corrected.clone().text()).toBe(201);
    const done = await resolveAs(conflictId, {
      outcome: "corrected",
      correctionId,
      note: "Corrected to given",
    });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(
      (await json<{ resolution: { correctionId: string } }>(done)).resolution.correctionId,
    ).toBe(correctionId);
    // The correction's author decided, so it is a self-review; neither they nor the uploader may
    // close its retrospective review (hazard HZ-004; clinical and security rechecks).
    const [review] = await asDemo(
      async (c) =>
        (
          await c.query<{ id: string; version: number }>(
            `SELECT id, version FROM task
              WHERE kind = 'medicines.administration.conflict_retrospective' AND source_id = $1`,
            [conflictId],
          )
        ).rows,
    );
    expect(review).toBeDefined();
    for (const who of ["owner", "manager"]) {
      const closed = await send(who, `/v1/tasks/${review?.id}/transition`, {
        method: "POST",
        body: { to: "done", version: review?.version },
      });
      expect(closed.status).toBe(403);
    }
  });

  it("hazard HZ-010 refuses a time given in the future beyond the clock drift allowance", async () => {
    const r = await send("manager", `/v1/people/${BEN}/medicine-administrations`, {
      method: "POST",
      headers: { [DEVICE_HEADER]: DEVICE },
      body: {
        id: randomUUID(),
        entryId: (
          await json<Round>(
            await send("manager", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`),
          )
        ).people.find((p) => p.personId === BEN)?.whenRequired[0]?.entryId,
        outcome: "given",
        amount: { quantity: 15, unitCode: ML.code },
        givenAt: new Date(Date.now() + 3 * 60 * MINUTE).toISOString(),
        givenBeforeRecorded: { reason: "Recorded on the tablet" },
        deviceOffsetMs: 0,
      },
    });
    expect(r.status).toBe(422);
    expect(await r.text()).toContain("given_at_in_future");
  });

  it("hazard HZ-004 a web session sending a device id is never treated as a device upload", async () => {
    const { email } = DEMO.users.manager;
    const auth = h.db.pool("harbour_auth");
    await auth.query("UPDATE auth.user SET two_factor_enabled = false WHERE email = $1", [email]);
    let cookie = "";
    try {
      const signIn = await h.request("/api/auth/sign-in/email", {
        method: "POST",
        body: { email, password: PASSWORD },
        origin: "http://localhost:3000",
      });
      expect(signIn.status).toBe(200);
      cookie =
        signIn.headers
          .getSetCookie()
          .find((x) => x.startsWith("harbour.session_token="))
          ?.split(";")[0] ?? "";
    } finally {
      await auth.query("UPDATE auth.user SET two_factor_enabled = true WHERE email = $1", [email]);
      await markSessionsVerified(auth);
    }
    const entryId = critical;
    const dueAt = (
      await json<Round>(
        await send("manager", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`),
      )
    ).people
      .find((p) => p.personId === ADA)
      ?.doses.find((d) => d.entryId === entryId)?.dueAt;
    const post = () =>
      h.request(`/v1/people/${ADA}/medicine-administrations`, {
        method: "POST",
        tenant: DEMO.tenantId,
        origin: "http://localhost:3000",
        headers: { cookie, [DEVICE_HEADER]: DEVICE },
        body: {
          id: randomUUID(),
          entryId,
          dueAt,
          outcome: "given",
          amount: { quantity: 1, unitCode: TABLET.code },
          timingReason: "Given with breakfast",
          deviceOffsetMs: 0,
        },
      });
    // Once to bind, once bound: both refused in words, never kept as a conflict.
    expect((await post()).status).toBe(422);
    expect((await post()).status).toBe(422);
  });

  it("hazards HZ-004 and HZ-116 a controlled drug's conflict needs two people, and given twice asks for the register entry", async () => {
    const cdEntry = randomUUID();
    const standing = randomUUID();
    const conflict = randomUUID();
    const due = new Date(Date.now() - 30 * MINUTE).toISOString();
    await asDemo(async (c) => {
      await c.query(
        `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, transcribed_by, transcribed_at, cd_schedule)
         VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Ibuprofen 200mg tablets', '26643006', 'Oral',
           'regular', 'every_day', 'Dr A Example', now() - interval '2 days', 'prescription',
           'Prescription', $4, now() - interval '2 days', '2')`,
        [cdEntry, CARL, IBUPROFEN.vmpId, DEMO.users.manager.id],
      );
      await c.query(
        `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
           quantity, unit_code, unit_name)
         VALUES ($1, $2, 0, $3, 'amount', 1, '428673006', 'tablet')`,
        [cdEntry, CARL, ukTime(new Date(due))],
      );
      await c.query(
        `INSERT INTO medication_administration (id, person_id, medication_id, due_at, outcome,
           quantity, unit_code, given_at, recorded_by)
         VALUES ($1, $2, $3, $4, 'given', 1, '428673006', $4, $5)`,
        [standing, CARL, cdEntry, due, DEMO.users.manager.id],
      );
      await c.query(
        `INSERT INTO medication_administration_conflict (id, person_id, client_record_id,
           medication_id, due_at, standing_id, uploaded, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          conflict,
          CARL,
          randomUUID(),
          cdEntry,
          due,
          standing,
          JSON.stringify({ id: randomUUID(), outcome: "given" }),
          DEMO.users.carer.id,
        ],
      );
    });
    const resolveAs = (who: string, body: Record<string, unknown>) =>
      send(who, `/v1/medicine-administration-conflicts/${conflict}/resolve`, {
        method: "POST",
        body,
      });
    // The person who recorded it cannot decide alone for a controlled drug.
    const own = await resolveAs("manager", { outcome: "first_stands", note: "Mine" });
    expect((await json<{ code: string }>(own)).code).toBe("conflict_own_record");
    const both = await resolveAs("owner", { outcome: "both_given", note: "Given twice" });
    expect(both.status, await both.clone().text()).toBe(200);
    const tasks = await asDemo(
      async (c) =>
        (
          await c.query<{ priority: string }>(
            "SELECT priority FROM task WHERE kind = 'medicines.cd.register_entry_due' AND source_id = $1",
            [conflict],
          )
        ).rows,
    );
    expect(tasks).toEqual([{ priority: "urgent" }]);
  });

  it("hazard HZ-003 the round takes each person's rates from their location's nation", async () => {
    // Wales has no medicines rates seeded yet (nation packs, Phase 7), so the test copies
    // England's for the organisation and sets its own early window.
    const keys = Object.values(MEDICINES_RATE_KEYS);
    const ids = await asDemo(async (c) => {
      await c.query("UPDATE location SET nation = 'wales' WHERE id = $1", [DEMO.locationId]);
      const copied = await c.query<{ id: string }>(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source,
           verification_status)
         SELECT $1, key, value, unit, 'wales', valid_from, source, verification_status
           FROM rate_table
          WHERE tenant_id IS NULL AND nation IN ('england', 'uk') AND key = ANY($2::text[])
            AND key <> 'medicines.dose_window.early_minutes'
         RETURNING id`,
        [DEMO.tenantId, keys],
      );
      const early = await c.query<{ id: string }>(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source,
           verification_status)
         VALUES ($1, 'medicines.dose_window.early_minutes', 5, 'minutes', 'wales', '2000-01-01',
           'test', 'verified') RETURNING id`,
        [DEMO.tenantId],
      );
      return [...copied.rows, ...early.rows].map((r) => r.id);
    });
    try {
      const round = await json<{
        people: { doses: { timeCritical: boolean; dueAt: string; opensAt: string }[] }[];
      }>(await send("manager", `/v1/locations/${DEMO.locationId}/medicine-round?${slot()}`));
      const regular = round.people.flatMap((p) => p.doses).filter((d) => !d.timeCritical);
      expect(regular.length).toBeGreaterThan(0);
      for (const d of regular) {
        expect(new Date(d.dueAt).getTime() - new Date(d.opensAt).getTime()).toBe(5 * MINUTE);
      }
    } finally {
      await asDemo(async (c) => {
        await c.query("DELETE FROM rate_table WHERE id = ANY($1::uuid[])", [ids]);
        await c.query("UPDATE location SET nation = 'england' WHERE id = $1", [DEMO.locationId]);
      });
    }
  });

  it("hazard HZ-004 a malformed double-dose event fails, so it is retried rather than lost", async () => {
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    const handler = outboxHandlers(deps).get("medicines.administration.double_dose");
    await expect(
      handler?.({
        id: randomUUID(),
        tenantId: DEMO.tenantId,
        payload: { conflictId: randomUUID() },
      } as unknown as Parameters<NonNullable<typeof handler>>[0]),
    ).rejects.toThrow(/malformed/);
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
