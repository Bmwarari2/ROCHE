import { randomUUID } from "node:crypto";
import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { ukDateOf, ukIsoDate, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workforceCompetence } from "../src/integrations/medicines-ports";
import { createHarness, type Harness } from "./support/harness";

/**
 * A dose recorded through the API with the real competence port (H-1532; HZ-119): the medicines
 * rules read the workforce sign-offs, so a member never signed off is refused and one signed off
 * is taken, through the route, not only the port.
 */
let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const PARACETAMOL = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
const ORAL = { code: "26643006", name: "Oral" };
const TABLET = { code: "428673006", name: "tablet" };
const MINUTE = 60_000;
const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const json = async <T>(r: Response) => (await r.json()) as T;
const POINT_OF_CARE = {
  identity: "photo",
  pack: { method: "override", override: { code: "no_barcode_on_pack", note: null } },
};
function ukTime(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence =
    workforceCompetence(createDatabase(h.db.pool("harbour_app")));
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-119 a dose is recorded only by a member the workforce sign-offs show competent (H-1532)", () => {
  let entryId = "";
  let dueAt = "";
  const give = (user: string, id: string) =>
    send(user, `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id,
        entryId,
        dueAt,
        outcome: "given",
        amount: { quantity: 2, unitCode: TABLET.code },
        timingReason: "Given with breakfast",
        pointOfCare: POINT_OF_CARE,
      },
    });

  it("refuses a member never signed off, and takes the dose once they are", async () => {
    const due = new Date(Date.now() + 3 * MINUTE);
    const entry = await send("manager", `/v1/people/${ADA}/medicines`, {
      method: "POST",
      body: {
        product: PARACETAMOL,
        route: ORAL,
        prescriber: "Dr A Example",
        startsAt: ukStartOfDay(ukDateOf(new Date())).toISOString(),
        source: { kind: "prescription", reference: "Prescription, Dr A Example, 08/11/2026" },
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [{ time: ukTime(due), dose: { kind: "amount", quantity: 2, unit: TABLET } }],
          },
        },
      },
    });
    expect(entry.status, await entry.clone().text()).toBe(201);
    entryId = (await json<{ id: string }>(entry)).id;
    const round = await json<{ doses: { entryId: string; dueAt: string }[] }>(
      await send("manager", `/v1/people/${ADA}/medicine-round`),
    );
    dueAt = round.doses.find((d) => d.entryId === entryId)?.dueAt as string;

    const refused = await give("manager", randomUUID());
    expect(refused.status, await refused.clone().text()).toBe(422);
    expect(await refused.text()).toMatch(/competence/i);

    const signed = await send(
      "nurse",
      `/v1/workforce/members/${DEMO.users.manager.id}/competences`,
      {
        method: "POST",
        body: { competence: "medicines_administration", observedOn: ukIsoDate(new Date()) },
      },
    );
    expect(signed.status, await signed.clone().text()).toBe(200);
    const taken = await give("manager", randomUUID());
    expect(taken.status, await taken.clone().text()).toBe(201);
  });
});
