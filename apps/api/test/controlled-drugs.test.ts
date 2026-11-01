import { randomUUID } from "node:crypto";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness } from "./support/harness";

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
) => {
  const r = await send(who, `/v1/controlled-drugs/pages/${pageId}/witness-assertions`, {
    method: "POST",
    body: { movement, quantity, administrationId },
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

describe("hazards HZ-009 and HZ-116 the register page and its entries", () => {
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
    pageId = page.id;
    expect((await json<{ id: string }>(await open())).id).toBe(pageId);
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
    const self = await receive({
      witness: { witnessAssertionId: await witness(pageId, "receipt", 28, null, "manager") },
    });
    expect(self.status).toBe(422);
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

  it("records a controlled drug given with its register entry, witnessed, in one transaction", async () => {
    const round = await json<{ doses: { entryId: string; dueAt: string }[] }>(
      await send("manager", `/v1/people/${ADA}/medicine-round`),
    );
    const dueAt = round.doses.find((d) => d.entryId === entryId)?.dueAt;
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
    givenId = id;
    givenDueAt = dueAt as string;
  });

  it("writes a margin correction on the register when a controlled drug's administration is corrected", async () => {
    const id = randomUUID();
    const r = await send("manager", `/v1/medicine-administrations/${givenId}/corrections`, {
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
