import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { ukDateOf, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { createHarness, type Harness } from "./support/harness";
import { pdfPages } from "./support/pdf-text";

/**
 * Medicines in the Phase 1 outputs (Phase 2 slice 49; MEDS-001, MEDS-002; medicines.md section
 * 16): the downtime pack lists each person's doses due from the eMAR, those still outstanding
 * first, and their when-required medicines with when last given (HZ-021); the transfer pack lists
 * the medicines in force with when each was last taken (HZ-023). Both say when they were read and
 * that they are not the live record, and a dose recorded afterwards makes the downtime pack stale.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const PARACETAMOL = { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" };
const LACTULOSE = { vmpId: "90000051000001100", ampId: null, name: "Lactulose" };
const ORAL = { code: "26643006", name: "Oral" };
const TABLET = { code: "428673006", name: "tablet" };
const ML = { code: "258773002", name: "ml" };
const SOURCE = { kind: "prescription", reference: "Prescription, Dr A Example, 31/10/2026" };
const MINUTE = 60_000;
const competence = fixedCompetence();
const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const json = async <T>(r: Response) => (await r.json()) as T;
const packUrl = `/v1/locations/${DEMO.locationId}/downtime-pack`;

function ukTime(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

async function transcribe(body: Record<string, unknown>) {
  const r = await send("manager", `/v1/people/${ADA}/medicines`, {
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

interface DueContent {
  status: string;
  producedAt?: string;
  due?: {
    name: string;
    dueAt: string;
    status: string;
    outstanding?: boolean;
  }[];
  prn?: { name: string; reason: string | null; lastGivenAt: string | null }[];
}
interface Pack {
  id: string;
  freshness: { state: string };
  pages: {
    personId: string;
    sections: { key: string; status: string }[];
    content: { medicinesDue: DueContent | null };
  }[];
}
const pack = async () => {
  const r = await send("manager", packUrl);
  expect(r.status, await r.clone().text()).toBe(200);
  return json<Pack>(r);
};

let regular = "";
let prn = "";
// Two hours ago, or just after midnight when that was yesterday: a dose earlier today, open.
const earlier = new Date(
  Math.max(Date.now() - 2 * 60 * MINUTE, ukStartOfDay(ukDateOf(new Date())).getTime() + MINUTE),
);

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  competence.held.set(`${DEMO.tenantId}:${DEMO.users.manager.id}`, "current");
  regular = (
    await transcribe({
      earlierDosesDueReason: "Due this morning; the paper MAR shows it was not given",
      directions: {
        kind: "regular",
        schedule: {
          pattern: { kind: "every_day" },
          times: [{ time: ukTime(earlier), dose: { kind: "amount", quantity: 1, unit: TABLET } }],
        },
      },
    })
  ).id;
  prn = (
    await transcribe({
      product: LACTULOSE,
      indication: "Constipation",
      directions: {
        kind: "when_required",
        dose: { kind: "amount", quantity: 15, unit: ML },
        maxQuantityPer24Hours: 30,
      },
    })
  ).id;
  const given = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
    method: "POST",
    body: {
      id: randomUUID(),
      entryId: prn,
      outcome: "given",
      amount: { quantity: 15, unitCode: ML.code },
    },
  });
  expect(given.status, await given.clone().text()).toBe(201);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-021 the downtime pack lists doses due from the eMAR", () => {
  it("hazard HZ-021 lists the outstanding dose first, the doses due and when-required medicines, with when it was read", async () => {
    const body = await pack();
    const page = body.pages.find((p) => p.personId === ADA);
    expect(page?.sections.find((s) => s.key === "medicines_due")?.status).toBe("included");
    const due = page?.content.medicinesDue;
    expect(due?.status).toBe("recorded");
    expect(due?.producedAt).toBeTruthy();
    const [first, ...rest] = due?.due ?? [];
    expect(first).toMatchObject({ name: PARACETAMOL.name, status: "due", outstanding: true });
    expect(new Date(first?.dueAt ?? 0).getTime()).toBeLessThan(Date.now());
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((d) => d.outstanding !== true)).toBe(true);
    expect(due?.prn).toEqual([
      expect.objectContaining({
        name: expect.stringMatching(/^Lactulose/),
        reason: "Constipation",
      }),
    ]);
    expect(due?.prn?.[0]?.lastGivenAt).toBeTruthy();
    // Someone with no eMAR entries keeps where the paper MAR is kept.
    const other = body.pages.find((p) => p.personId !== ADA);
    expect(other?.sections.find((s) => s.key === "medicines_due")?.status).toBe("held_elsewhere");
  });

  it("hazard HZ-021 prints that the list is not the live record, and the outstanding dose in words", async () => {
    const r = await send("manager", `${packUrl}?format=pdf`);
    expect(r.status).toBe(200);
    const text = pdfPages(new Uint8Array(await r.arrayBuffer()))
      .flat()
      .join(" ");
    expect(text).toContain("This is not the live record");
    expect(text).toContain("Outstanding, was due ");
  });

  it("hazard HZ-021 goes stale, and is built again, once a dose on it is recorded", async () => {
    const before = await pack();
    const dueAt = before.pages
      .find((p) => p.personId === ADA)
      ?.content.medicinesDue?.due?.find((d) => d.outstanding)?.dueAt;
    const recorded = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId: regular,
        dueAt,
        outcome: "given",
        amount: { quantity: 1, unitCode: TABLET.code },
        timingReason: "Given late after a visit",
      },
    });
    expect(recorded.status, await recorded.clone().text()).toBe(201);
    const after = await pack();
    expect(after.id).not.toBe(before.id);
    const ada = after.pages.find((p) => p.personId === ADA)?.content.medicinesDue;
    expect(ada?.due?.some((d) => d.outstanding)).toBe(false);
  });
});

interface TransferPack {
  missingCritical: string[];
  attention?: { code: string }[];
  content: {
    medicines: {
      status: string;
      source?: string;
      producedAt?: string;
      items?: {
        name: string;
        dose: string;
        frequency: string;
        lastGivenAt: string | null;
        status?: string | null;
      }[];
    };
  };
}

describe("hazard HZ-023 the transfer pack lists medicines from the eMAR", () => {
  it("hazard HZ-023 lists each medicine in force with when it was last taken, read from the eMAR now", async () => {
    const r = await send("manager", `/v1/people/${ADA}/transfer-pack`);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = await json<TransferPack>(r);
    expect(body.missingCritical).not.toContain("medicines");
    expect(body.attention?.map((a) => a.code) ?? []).not.toContain("medicines_need_checking");
    const m = body.content.medicines;
    expect(m).toMatchObject({ status: "recorded", source: "emar" });
    expect(m.producedAt).toBeTruthy();
    const lactulose = m.items?.find((i) => i.name.startsWith("Lactulose"));
    expect(lactulose).toMatchObject({ dose: "15 ml", frequency: "When required" });
    expect(lactulose?.lastGivenAt).toBeTruthy();
    const paracetamol = m.items?.find((i) => i.name === PARACETAMOL.name);
    expect(paracetamol?.frequency).toMatch(/every day at/);
    // Given late in the downtime test above; the entry is not yet checked, which travels with it.
    expect(paracetamol?.lastGivenAt).toBeTruthy();
    expect(paracetamol?.status).toMatch(/^Not yet checked against the source document/);
  });

  it("hazard HZ-023 keeps the Phase 1 source for someone with no eMAR entries", async () => {
    const r = await send(
      "manager",
      "/v1/people/0194d000-0000-7000-8600-000000000002/transfer-pack",
    );
    expect(r.status).toBe(200);
    const body = await json<TransferPack>(r);
    expect(body.content.medicines.source).not.toBe("emar");
  });
});
