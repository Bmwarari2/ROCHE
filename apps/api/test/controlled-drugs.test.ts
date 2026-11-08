import { randomUUID } from "node:crypto";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The controlled drugs register API (Phase 2 slice 34; MEDS-005; medicines.md section 14): the
 * witness signs first with their own step-up (ADR-0084), the recorder's entry names that
 * signature, slice 3's rules check every entry on the page as it stands, an administration of a
 * controlled drug writes its register entry with the record, a correction is a margin entry, and
 * a stock check that does not balance raises a medication incident through the safety module.
 * The demo home runs residential and nursing services, so every entry needs a witness. The
 * Registered Manager records; the care worker witnesses.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const BEN = "0194d000-0000-7000-8600-000000000002";
const MORPHINE = "90000081000001109";
const TABLET = { code: "428673006", name: "tablet" };
const MINUTE = 60_000;
const competence = fixedCompetence();
const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
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

/** A morphine entry due in 3 minutes, with dm+d's controlled drug schedule (slice 10 sets it). */
async function morphineEntry(personId: string): Promise<string> {
  const id = randomUUID();
  await asDemo(async (c) => {
    await c.query(
      `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
         route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
         source_reference, transcribed_by, transcribed_at, cd_schedule)
       VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Morphine sulfate 10mg tablets', '26643006', 'Oral',
         'regular', 'every_day', 'Dr A Example', now() - interval '1 day', 'prescription',
         'Prescription', $4, now() - interval '1 day', '2')`,
      [id, personId, MORPHINE, DEMO.users.manager.id],
    );
    await c.query(
      `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
         quantity, unit_code, unit_name)
       VALUES ($1, $2, 0, $3, 'amount', 1, '428673006', 'tablet')`,
      [id, personId, ukTime(new Date(Date.now() + 3 * MINUTE))],
    );
  });
  return id;
}

const witness = async (
  pageId: string,
  movement: string,
  quantity: number,
  administrationId: string | null = null,
  who = "carer",
  recorder: string = DEMO.users.manager.id,
) => {
  const r = await send(who, `/v1/controlled-drugs/pages/${pageId}/witness-assertions`, {
    method: "POST",
    body: { movement, quantity, administrationId, recorderId: recorder },
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await json<{ id: string }>(r)).id;
};

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

describe("hazards HZ-115 and HZ-116 the register page and its entries", () => {
  let entryId = "";
  let pageId = "";
  let receiptId = "";
  let givenId = "";
  let givenDueAt = "";

  it("opens one page per person and product, only for a controlled drug", async () => {
    entryId = await morphineEntry(ADA);
    const open = () =>
      send("manager", `/v1/people/${ADA}/controlled-drugs/pages`, {
        method: "POST",
        body: { entryId },
      });
    const first = await open();
    expect(first.status, await first.clone().text()).toBe(200);
    const page = await json<{ id: string; balance: number; witnessPolicy: string }>(first);
    expect(page.balance).toBe(0);
    expect(page.witnessPolicy).toBe("required");
    // A page never checked is due a count from when it was opened.
    expect(
      (page as unknown as { nextStockCheckDueAt: string | null }).nextStockCheckDueAt,
    ).not.toBeNull();
    pageId = page.id;
    expect((await json<{ id: string }>(await open())).id).toBe(pageId);
  });

  it("hazard HZ-115 says a controlled drug's MAR entry is one in the write's own response", async () => {
    // The second check returns the entry: it says so, as the MAR read does (web corrections).
    const checked = await send("owner", `/v1/medicines/${entryId}/check`, {
      method: "POST",
      body: { outcome: "matches_source", comparedWithSource: true },
    });
    expect(checked.status, await checked.clone().text()).toBe(200);
    expect((await json<{ controlledDrug: boolean }>(checked)).controlledDrug).toBe(true);
  });

  it("takes a witnessed receipt, and refuses one without a witness, by the witness, or unsigned for", async () => {
    const receive = (body: Record<string, unknown>) =>
      send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
        method: "POST",
        body: {
          movement: "receipt",
          quantity: 28,
          counterparty: "Example Pharmacy",
          reference: "Delivery note 1001",
          ...body,
        },
      });
    const lone = await receive({ witness: { noWitnessReason: "Nobody else on shift" } });
    expect(lone.status).toBe(422);
    expect((await json<{ code: string }>(lone)).code).toBe("cd_witness_required");
    const selfSign = await send(
      "manager",
      `/v1/controlled-drugs/pages/${pageId}/witness-assertions`,
      {
        method: "POST",
        body: { movement: "receipt", quantity: 28, recorderId: DEMO.users.manager.id },
      },
    );
    expect(selfSign.status).toBe(422);
    // A signature for another recorder cannot be used by this one.
    const forOwner = await receive({
      witness: {
        witnessAssertionId: await witness(
          pageId,
          "receipt",
          28,
          null,
          "carer",
          DEMO.users.owner.id,
        ),
      },
    });
    expect(forOwner.status).toBe(422);
    const other = await receive({
      witness: { witnessAssertionId: await witness(pageId, "receipt", 27) },
    });
    expect(other.status).toBe(422);
    const ok = await receive({
      witness: { witnessAssertionId: await witness(pageId, "receipt", 28) },
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const entry = await json<{ id: string; balanceAfter: number; witnessId: string }>(ok);
    expect(entry.balanceAfter).toBe(28);
    expect(entry.witnessId).toBe(DEMO.users.carer.id);
    receiptId = entry.id;
  });

  it("lists whom a witness may sign for, never themselves (slice 54)", async () => {
    const r = await send("carer", `/v1/controlled-drugs/pages/${pageId}/recorders`);
    expect(r.status, await r.clone().text()).toBe(200);
    const ids = (await json<{ recorders: { id: string; name: string }[] }>(r)).recorders.map(
      (x) => x.id,
    );
    expect(ids).toContain(DEMO.users.manager.id);
    expect(ids).not.toContain(DEMO.users.carer.id);
  });

  it("hazard HZ-116 shows a recorder only the witness signatures waiting for them (slice 54)", async () => {
    const forManager = await witness(pageId, "disposal", 1);
    const forOwner = await witness(pageId, "disposal", 1, null, "carer", DEMO.users.owner.id);
    const mine = await json<{
      assertions: { id: string; movement: string; quantity: number; witnessName: string }[];
    }>(await send("manager", `/v1/controlled-drugs/pages/${pageId}/witness-assertions`));
    const ids = mine.assertions.map((a) => a.id);
    expect(ids).toContain(forManager);
    expect(ids).not.toContain(forOwner);
    expect(mine.assertions.find((a) => a.id === forManager)).toMatchObject({
      movement: "disposal",
      quantity: 1,
      administrationId: null,
      witnessName: DEMO.users.carer.name,
    });
    // A signature for a dose record names that record, so the web offers it to that one only.
    const doseRecord = randomUUID();
    const forDose = await witness(pageId, "administration", 1, doseRecord);
    const again = await json<{ assertions: { id: string; administrationId: string | null }[] }>(
      await send("manager", `/v1/controlled-drugs/pages/${pageId}/witness-assertions`),
    );
    expect(again.assertions.find((a) => a.id === forDose)?.administrationId).toBe(doseRecord);
  });

  it("hazard HZ-116 refuses the slice 54 reads to members without the permission or the page (slice 54)", async () => {
    // The quality lead holds neither medicines.cd.witness nor a recording permission.
    expect((await send("quality", `/v1/controlled-drugs/pages/${pageId}/recorders`)).status).toBe(
      403,
    );
    expect(
      (await send("quality", `/v1/controlled-drugs/pages/${pageId}/witness-assertions`)).status,
    ).toBe(403);
    // A page that does not exist, or that the caller's scope cannot see, is not found.
    const other = randomUUID();
    expect((await send("carer", `/v1/controlled-drugs/pages/${other}/recorders`)).status).toBe(404);
    expect(
      (await send("manager", `/v1/controlled-drugs/pages/${other}/witness-assertions`)).status,
    ).toBe(404);
  });

  it("names everyone who signed the page, for the screens and the print (slice 54)", async () => {
    const page = await json<{ people: { id: string; name: string }[] }>(
      await send("manager", `/v1/controlled-drugs/pages/${pageId}`),
    );
    expect(page.people).toEqual(
      expect.arrayContaining([
        { id: DEMO.users.manager.id, name: DEMO.users.manager.name },
        { id: DEMO.users.carer.id, name: DEMO.users.carer.name },
      ]),
    );
  });

  it("hazard HZ-119 refuses a witness whose medicines competence is not current", async () => {
    const key = `${DEMO.tenantId}:${DEMO.users.carer.id}`;
    competence.held.set(key, "expired");
    const r = await send("carer", `/v1/controlled-drugs/pages/${pageId}/witness-assertions`, {
      method: "POST",
      body: { movement: "receipt", quantity: 1, recorderId: DEMO.users.manager.id },
    });
    competence.held.set(key, "current");
    expect(r.status).toBe(422);
    expect((await json<{ code: string }>(r)).code).toBe("cd_witness_not_competent");
  });

  it("needs a fresh step-up from the recorder and the witness", async () => {
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.manager?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const r = await send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
        method: "POST",
        body: {
          movement: "disposal",
          quantity: 1,
          witness: { witnessAssertionId: randomUUID() },
        },
      });
      expect(r.status).toBe(403);
    } finally {
      await ageSession(auth, session, 0);
    }
  });

  it("refuses a controlled drug from someone without medicines.cd.administer, and one taken by the person themselves", async () => {
    const round = await json<{ doses: { entryId: string; dueAt: string; state: string }[] }>(
      await send("manager", `/v1/people/${ADA}/medicine-round`),
    );
    // Today's dose: the round also carries any earlier dose still late (medicines.md 15.1).
    const dueAt = round.doses.find((d) => d.entryId === entryId && d.state !== "late")?.dueAt;
    const carer = await send("carer", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId,
        dueAt,
        outcome: "given",
        amount: { quantity: 1, unitCode: TABLET.code },
        controlledDrug: { noWitnessReason: "Nobody else on shift" },
      },
    });
    expect(carer.status).toBe(403);
    const self = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId,
        dueAt,
        outcome: "self_administered",
        amount: { quantity: 1, unitCode: TABLET.code },
      },
    });
    expect(self.status).toBe(422);
    expect((await json<{ code: string }>(self)).code).toBe(
      "administration_cd_outcome_not_recorded",
    );
  });

  it("records a controlled drug given with its register entry, witnessed, in one transaction", async () => {
    const round = await json<{ doses: { entryId: string; dueAt: string; state: string }[] }>(
      await send("manager", `/v1/people/${ADA}/medicine-round`),
    );
    // Today's dose: the round also carries any earlier dose still late (medicines.md 15.1).
    const dueAt = round.doses.find((d) => d.entryId === entryId && d.state !== "late")?.dueAt;
    const id = randomUUID();
    const give = (controlledDrug: unknown) =>
      send("manager", `/v1/people/${ADA}/medicine-administrations`, {
        method: "POST",
        body: {
          id,
          entryId,
          dueAt,
          outcome: "given",
          amount: { quantity: 1, unitCode: TABLET.code },
          controlledDrug,
        },
      });
    expect((await give(null)).status).toBe(422);
    const r = await give({ witnessAssertionId: await witness(pageId, "administration", 1, id) });
    expect(r.status, await r.clone().text()).toBe(201);
    const page = await json<{
      balance: number;
      entries: { movement: string; administrationId: string | null }[];
    }>(await send("manager", `/v1/controlled-drugs/pages/${pageId}`));
    expect(page.balance).toBe(27);
    expect(page.entries.at(-1)).toMatchObject({ movement: "administration", administrationId: id });
    // The record says it is in the register, so a correction corrects that entry (web screens).
    const recorded = await json<{ administration: { inCdRegister: boolean } }>(r);
    expect(recorded.administration.inCdRegister).toBe(true);
    // The MAR says the medicine is a controlled drug, so the web asks for a witness (HZ-115).
    const mar = await json<{ entries: { id: string; controlledDrug: boolean }[] }>(
      await send("manager", `/v1/people/${ADA}/medicines`),
    );
    expect(mar.entries.find((e) => e.id === entryId)?.controlledDrug).toBe(true);
    givenId = id;
    givenDueAt = dueAt as string;
  });

  it("writes a margin correction on the register when a controlled drug's administration is corrected, through a correction that moved no stock", async () => {
    // First a correction that changes nothing the register counts: it carries the entry forward.
    const records = await json<{ administrations: { id: string; givenAt: string }[] }>(
      await send(
        "manager",
        `/v1/people/${ADA}/medicine-administrations?from=${encodeURIComponent(
          new Date(Date.now() - 60 * MINUTE).toISOString(),
        )}&to=${encodeURIComponent(new Date(Date.now() + 60 * MINUTE).toISOString())}`,
      ),
    );
    const givenAt = records.administrations.find((a) => a.id === givenId)?.givenAt as string;
    const first = randomUUID();
    const same = await send("manager", `/v1/medicine-administrations/${givenId}/corrections`, {
      method: "POST",
      body: {
        id: first,
        correctionReason: "The reason for the timing was recorded on the wrong dose",
        entryId,
        dueAt: givenDueAt,
        outcome: "given",
        amount: { quantity: 1, unitCode: TABLET.code },
        givenAt,
      },
    });
    expect(same.status, await same.clone().text()).toBe(201);
    const id = randomUUID();
    const r = await send("manager", `/v1/medicine-administrations/${first}/corrections`, {
      method: "POST",
      body: {
        id,
        correctionReason: "Recorded as given, but she declined it and it was returned to the pot",
        entryId,
        dueAt: givenDueAt,
        outcome: "refused",
        reason: { code: "declined", note: null },
        givenAt: new Date().toISOString(),
        controlledDrug: { witnessAssertionId: await witness(pageId, "correction", 1, id) },
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const page = await json<{
      balance: number;
      entries: { movement: string; quantity: number; administrationId: string | null }[];
    }>(await send("manager", `/v1/controlled-drugs/pages/${pageId}`));
    expect(page.balance).toBe(28);
    expect(page.entries.at(-1)).toMatchObject({
      movement: "correction",
      quantity: 1,
      administrationId: id,
    });
  });

  it("puts a mistake right with a margin correction, shown beside the entry, never an edit", async () => {
    const correct = (body: Record<string, unknown>) =>
      send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
        method: "POST",
        body: { movement: "correction", corrects: "quantity", correctsId: receiptId, ...body },
      });
    const noReason = await correct({
      quantity: -2,
      witness: { witnessAssertionId: await witness(pageId, "correction", -2) },
    });
    expect(noReason.status).toBe(422);
    const r = await correct({
      quantity: -2,
      reason: "The delivery was 26 tablets, not 28",
      witness: { witnessAssertionId: await witness(pageId, "correction", -2) },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const page = await json<{
      balance: number;
      entries: { id: string; correctedBy: string[] }[];
    }>(await send("manager", `/v1/controlled-drugs/pages/${pageId}`));
    expect(page.balance).toBe(26);
    expect(page.entries.find((e) => e.id === receiptId)?.correctedBy.length).toBe(1);
  });

  it("destroys only with a witness", async () => {
    const destroy = (w: unknown) =>
      send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
        method: "POST",
        body: { movement: "destruction", quantity: 1, reference: "Denaturing kit 7", witness: w },
      });
    expect((await destroy({ noWitnessReason: "Out of hours" })).status).toBe(422);
    const r = await destroy({ witnessAssertionId: await witness(pageId, "destruction", 1) });
    expect(r.status, await r.clone().text()).toBe(201);
  });

  it("hazard HZ-115 raises a medication incident through the safety module when a count does not balance", async () => {
    const check = (counted: number, reason: string | null) =>
      witness(pageId, "stock_check", counted).then((assertion) =>
        send("manager", `/v1/controlled-drugs/pages/${pageId}/stock-checks`, {
          method: "POST",
          body: { counted, reason, witness: { witnessAssertionId: assertion } },
        }),
      );
    const balanced = await check(25, null);
    expect(balanced.status, await balanced.clone().text()).toBe(201);
    expect((await json<{ incidentRaised: boolean }>(balanced)).incidentRaised).toBe(false);
    expect((await check(24, null)).status).toBe(422);
    const short = await check(24, "One tablet could not be found in the cupboard");
    expect(short.status).toBe(201);
    const out = await json<{
      stockCheck: { id: string; resultInWords: string };
      incidentRaised: boolean;
    }>(short);
    expect(out.incidentRaised).toBe(true);
    expect(out.stockCheck.resultInWords).toMatch(/^Short by 1 tablet/);
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
            [out.stockCheck.id],
          )
        ).rows,
    );
    expect(incidents).toEqual([{ type: "medication", person_ids: [ADA] }]);
    // The page keeps saying so for everyone who reads it later, and in print (slice 54).
    const page = await json<{ stockChecks: { id: string; incidentRaised: boolean }[] }>(
      await send("manager", `/v1/controlled-drugs/pages/${pageId}`),
    );
    expect(page.stockChecks.find((s) => s.id === out.stockCheck.id)?.incidentRaised).toBe(true);
    expect(page.stockChecks.some((s) => !s.incidentRaised)).toBe(true);
  });

  it("hazard HZ-011 lists the person's pages, and audits by id, never the drug or the count", async () => {
    const list = await json<{ pages: { id: string; lastStockCheck: unknown }[] }>(
      await send("manager", `/v1/people/${ADA}/controlled-drugs`),
    );
    expect(list.pages.map((p) => p.id)).toEqual([pageId]);
    expect(list.pages[0]?.lastStockCheck).not.toBeNull();
    expect((await send("manager", `/v1/people/${BEN}/controlled-drugs`)).status).toBe(200);
    const rows = await asDemo(
      async (c) =>
        (
          await c.query<{ action: string; outcome: string; text: string }>(
            `SELECT action, outcome, coalesce(scope::text, '') AS text FROM audit_event
              WHERE action LIKE 'medicines.cd.%'`,
          )
        ).rows,
    );
    const actions = new Set(rows.map((r) => `${r.action}:${r.outcome}`));
    for (const a of [
      "medicines.cd.page_opened:success",
      "medicines.cd.witness_asserted:success",
      "medicines.cd.entry_recorded:success",
      "medicines.cd.entry_recorded:denied",
      "medicines.cd.stock_checked:success",
      "medicines.cd.viewed:success",
    ]) {
      expect(actions.has(a), [...actions].join(", ")).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toMatch(/Morphine|tablet|Example Pharmacy|cupboard/);
  });
});

describe("hazard HZ-115 nothing goes in the register where controlled drug recording is not turned on (H-1517)", () => {
  const setRecording = (enabled: boolean) =>
    asDemo((c) =>
      c.query(
        "UPDATE feature_flag SET enabled = $2 WHERE flag_key = 'medicines.cd_recording' AND location_id = $1",
        [DEMO.locationId, enabled],
      ),
    );
  const refusedFor = async (r: Response) => {
    expect(r.status, await r.clone().text()).toBe(409);
    expect((await json<{ code: string }>(r)).code).toBe("cd_recording_not_enabled");
  };

  it("refuses every write with 409 cd_recording_not_enabled, audited, and takes them again once released", async () => {
    // A page opened while recording is released, then recording turned off at the home.
    const entryId = await morphineEntry(BEN);
    const opened = await send("manager", `/v1/people/${BEN}/controlled-drugs/pages`, {
      method: "POST",
      body: { entryId },
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const pageId = (await json<{ id: string }>(opened)).id;
    const registerRows = () =>
      asDemo(
        async (c) =>
          (
            await c.query(
              `SELECT (SELECT count(*) FROM controlled_drug_page)::int AS pages,
                      (SELECT count(*) FROM controlled_drug_entry)::int AS entries,
                      (SELECT count(*) FROM controlled_drug_stock_check)::int AS checks`,
            )
          ).rows[0],
      );
    // A receipt and a dose given while released, so there is something to correct later.
    const receipt = await send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
      method: "POST",
      body: {
        movement: "receipt",
        quantity: 28,
        counterparty: "Example Pharmacy",
        reference: "Delivery note 2002",
        witness: { witnessAssertionId: await witness(pageId, "receipt", 28) },
      },
    });
    expect(receipt.status, await receipt.clone().text()).toBe(201);
    const dueRound = await json<{ doses: { entryId: string; dueAt: string; state: string }[] }>(
      await send("manager", `/v1/people/${BEN}/medicine-round`),
    );
    const givenDue = dueRound.doses.find((d) => d.entryId === entryId && d.state !== "late")
      ?.dueAt as string;
    const givenId = randomUUID();
    const gave = await send("manager", `/v1/people/${BEN}/medicine-administrations`, {
      method: "POST",
      body: {
        id: givenId,
        entryId,
        dueAt: givenDue,
        outcome: "given",
        amount: { quantity: 1, unitCode: TABLET.code },
        controlledDrug: {
          witnessAssertionId: await witness(pageId, "administration", 1, givenId),
        },
      },
    });
    expect(gave.status, await gave.clone().text()).toBe(201);
    const givenAt = (await json<{ administration: { givenAt: string } }>(gave)).administration
      .givenAt;
    const before = await registerRows();
    await setRecording(false);
    try {
      // Opening a page.
      const another = await morphineEntry(BEN);
      await refusedFor(
        await send("manager", `/v1/people/${BEN}/controlled-drugs/pages`, {
          method: "POST",
          body: { entryId: another },
        }),
      );
      // Signing as a witness.
      await refusedFor(
        await send("carer", `/v1/controlled-drugs/pages/${pageId}/witness-assertions`, {
          method: "POST",
          body: {
            movement: "receipt",
            quantity: 28,
            administrationId: null,
            recorderId: DEMO.users.manager.id,
          },
        }),
      );
      // A receipt (any movement or correction goes through the same route).
      await refusedFor(
        await send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
          method: "POST",
          body: {
            movement: "receipt",
            quantity: 28,
            counterparty: "Example Pharmacy",
            reference: "Delivery note 2001",
            witness: { witnessAssertionId: randomUUID() },
          },
        }),
      );
      // A stock count.
      await refusedFor(
        await send("manager", `/v1/controlled-drugs/pages/${pageId}/stock-checks`, {
          method: "POST",
          body: { counted: 0, reason: null, witness: { witnessAssertionId: randomUUID() } },
        }),
      );
      // A controlled drug given, which would write its register entry.
      const round = await json<{ doses: { entryId: string; dueAt: string }[] }>(
        await send("manager", `/v1/people/${BEN}/medicine-round`),
      );
      const dueAt = round.doses.find((d) => d.entryId === entryId)?.dueAt;
      await refusedFor(
        await send("manager", `/v1/people/${BEN}/medicine-administrations`, {
          method: "POST",
          body: {
            id: randomUUID(),
            entryId,
            dueAt,
            outcome: "given",
            amount: { quantity: 1, unitCode: TABLET.code },
            controlledDrug: { witnessAssertionId: randomUUID() },
          },
        }),
      );
      // Correcting the amount of the controlled drug given while recording was released.
      await refusedFor(
        await send("manager", `/v1/medicine-administrations/${givenId}/corrections`, {
          method: "POST",
          body: {
            id: randomUUID(),
            correctionReason: "Two tablets were given, not one",
            entryId,
            dueAt: givenDue,
            outcome: "given",
            // A different amount moves the register's balance, so it would write a margin entry.
            amount: { quantity: 2, unitCode: TABLET.code },
            amountDifferenceReason: "Two tablets were given by mistake",
            givenAt: givenAt,
          },
        }),
      );
      // Nothing reached the register.
      expect(await registerRows()).toEqual(before);
      // Each refusal is audited as denied, with its code.
      const denied = await asDemo(async (c) =>
        (
          await c.query(
            `SELECT action FROM audit_event
              WHERE outcome = 'denied' AND scope::text LIKE '%cd_recording_not_enabled%'`,
          )
        ).rows.map((r) => r.action as string),
      );
      expect(new Set(denied)).toEqual(
        new Set([
          "medicines.cd.page_opened",
          "medicines.cd.witness_asserted",
          "medicines.cd.entry_recorded",
          "medicines.cd.stock_checked",
          "medicines.administration.recorded",
          "medicines.administration.corrected",
        ]),
      );
    } finally {
      await setRecording(true);
    }
    // Released again: the page opens as before.
    const again = await send("manager", `/v1/people/${BEN}/controlled-drugs/pages`, {
      method: "POST",
      body: { entryId },
    });
    expect(again.status).toBe(200);
  });
});

describe("hazard HZ-115 hazard HZ-008 turning controlled drug recording on and off at a home (H-1518)", () => {
  const path = `/v1/locations/${DEMO.locationId}/controlled-drugs/recording`;
  const on = {
    enabled: true,
    paperRegisterClosed: true,
    balancesToCarryForward: true,
    phonesUpdated: true,
  };
  const off = {
    enabled: false,
    reason: "Phones at the home are being replaced this week",
    paperRegisterRestarted: true,
  };
  const flag = () =>
    asDemo(
      async (c) =>
        (
          await c.query<{ enabled: boolean }>(
            "SELECT enabled FROM feature_flag WHERE flag_key = 'medicines.cd_recording' AND location_id = $1",
            [DEMO.locationId],
          )
        ).rows[0]?.enabled ?? false,
    );
  const audits = (outcome: string) =>
    asDemo(
      async (c) =>
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_event
              WHERE action = 'medicines.cd_recording.changed' AND resource_id = $1 AND outcome = $2`,
            [DEMO.locationId, outcome],
          )
        ).rows[0]?.n ?? 0,
    );

  it("lets the Registered Manager turn it off with a reason, refuses register writes, and turn it on again", async () => {
    const before = await audits("success");
    const turnedOff = await send("manager", path, { method: "PUT", body: off });
    expect(turnedOff.status, await turnedOff.clone().text()).toBe(200);
    expect(await json(turnedOff)).toEqual({
      locationId: DEMO.locationId,
      enabled: false,
      changed: true,
    });
    expect(await flag()).toBe(false);
    try {
      const entryId = await morphineEntry(ADA);
      const refused = await send("manager", `/v1/people/${ADA}/controlled-drugs/pages`, {
        method: "POST",
        body: { entryId },
      });
      expect(refused.status).toBe(409);
      expect((await json<{ code: string }>(refused)).code).toBe("cd_recording_not_enabled");
    } finally {
      const turnedOn = await send("manager", path, { method: "PUT", body: on });
      expect(turnedOn.status, await turnedOn.clone().text()).toBe(200);
    }
    expect(await flag()).toBe(true);
    expect(await audits("success")).toBe(before + 2);
    // Asking for what is already so changes nothing and writes no audit.
    const again = await send("manager", path, { method: "PUT", body: on });
    expect((await json<{ changed: boolean }>(again)).changed).toBe(false);
    expect(await audits("success")).toBe(before + 2);
  });

  it.each([
    [
      "turning it on without saying the paper register is closed",
      { ...on, paperRegisterClosed: false },
    ],
    [
      "turning it on without the balances to carry forward",
      { ...on, balancesToCarryForward: undefined },
    ],
    ["turning it off without a reason", { ...off, reason: " " }],
    [
      "turning it off without restarting the paper register",
      { ...off, paperRegisterRestarted: false },
    ],
  ])("refuses %s", async (_case, body) => {
    const r = await send("manager", path, { method: "PUT", body });
    expect(r.status).toBe(422);
    expect(await flag()).toBe(true);
  });

  it("keeps why it was turned off with the setting, never in the audit trail", async () => {
    const turnedOff = await send("manager", path, { method: "PUT", body: off });
    expect(turnedOff.status, await turnedOff.clone().text()).toBe(200);
    try {
      const stored = await asDemo(async (c) => ({
        value: (
          await c.query<{ value: { reason?: string } | null }>(
            "SELECT value FROM feature_flag WHERE flag_key = 'medicines.cd_recording' AND location_id = $1",
            [DEMO.locationId],
          )
        ).rows[0]?.value,
        audited: (
          await c.query<{ scope: string }>(
            `SELECT scope::text AS scope FROM audit_event
              WHERE action = 'medicines.cd_recording.changed' AND resource_id = $1
              ORDER BY occurred_at DESC LIMIT 1`,
            [DEMO.locationId],
          )
        ).rows[0]?.scope,
      }));
      expect(stored.value?.reason).toBe(off.reason);
      expect(stored.audited).toContain("reasonGiven");
      expect(stored.audited).not.toContain(off.reason);
    } finally {
      await send("manager", path, { method: "PUT", body: on });
    }
  });

  it("turns it off at the home even where the organisation turned it on for every home", async () => {
    await asDemo(async (c) => {
      await c.query(
        "UPDATE feature_flag SET deleted_at = now() WHERE flag_key = 'medicines.cd_recording' AND location_id = $1",
        [DEMO.locationId],
      );
      await c.query(
        `INSERT INTO feature_flag (tenant_id, location_id, flag_key, enabled)
         VALUES ($1, NULL, 'medicines.cd_recording', true)`,
        [DEMO.tenantId],
      );
    });
    try {
      const r = await send("manager", path, { method: "PUT", body: off });
      expect(r.status, await r.clone().text()).toBe(200);
      expect((await json<{ changed: boolean; enabled: boolean }>(r)).changed).toBe(true);
      expect(await flag()).toBe(false);
      const entryId = await morphineEntry(ADA);
      const refused = await send("manager", `/v1/people/${ADA}/controlled-drugs/pages`, {
        method: "POST",
        body: { entryId },
      });
      expect(refused.status).toBe(409);
    } finally {
      await asDemo((c) =>
        c.query(
          "DELETE FROM feature_flag WHERE flag_key = 'medicines.cd_recording' AND location_id IS NULL",
        ),
      );
      const back = await send("manager", path, { method: "PUT", body: on });
      expect(back.status, await back.clone().text()).toBe(200);
    }
    expect(await flag()).toBe(true);
  });

  it.each([
    ["another home the manager does not manage", LODGE.locationId],
    ["another organisation's home", OTHER.locationId],
  ])("does not change %s, and audits the refusal", async (_case, locationId) => {
    const before = await asDemo(
      async (c) =>
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_event
              WHERE action = 'medicines.cd_recording.changed' AND resource_id = $1 AND outcome = 'denied'`,
            [locationId],
          )
        ).rows[0]?.n ?? 0,
    );
    const r = await send("manager", `/v1/locations/${locationId}/controlled-drugs/recording`, {
      method: "PUT",
      body: off,
    });
    expect(r.status).toBe(404);
    const after = await asDemo(
      async (c) =>
        (
          await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM audit_event
              WHERE action = 'medicines.cd_recording.changed' AND resource_id = $1 AND outcome = 'denied'`,
            [locationId],
          )
        ).rows[0]?.n ?? 0,
    );
    expect(after).toBeGreaterThan(before);
  });

  it("is not for a care worker or a nurse, and refuses a stale second sign-in step, audited", async () => {
    for (const user of ["carer", "nurse"]) {
      const r = await send(user, path, { method: "PUT", body: off });
      expect([403, 404], `${user}: ${r.status}`).toContain(r.status);
    }
    expect(await flag()).toBe(true);
    const deniedBefore = await audits("denied");
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.manager?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const r = await send("manager", path, { method: "PUT", body: off });
      expect(r.status).toBe(403);
      expect((await json<{ code: string }>(r)).code).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
    expect(await flag()).toBe(true);
    expect(await audits("denied")).toBeGreaterThan(deniedBefore);
  });
});
