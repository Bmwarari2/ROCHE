import { randomUUID } from "node:crypto";
import { createDatabase, type Transaction } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { withAdminClient } from "@harbour/db/testing";
import { ukDateOf, ukStartOfDay } from "@harbour/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { recentAdministrations } from "../src/services/medicine-administrations";
import { createHarness, type Harness, LODGE } from "./support/harness";
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
const CARL = "0194d000-0000-7000-8600-000000000003";
const DEV = "0194d000-0000-7000-8600-000000000004";
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

async function transcribe(body: Record<string, unknown>, personId = ADA) {
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

interface DueContent {
  status: string;
  producedAt?: string;
  due?: {
    name: string;
    dueAt: string;
    status: string;
    outstanding?: boolean;
    onHold?: boolean;
    notice?: string | null;
  }[];
  prn?: { name: string; reason: string | null; lastGivenAt: string | null; onHold?: boolean }[];
}
interface Pack {
  id: string;
  warnings: { personId: string; kind: string }[];
  freshness: { state: string };
  pages: {
    personId: string;
    sections: { key: string; status: string; note: string | null }[];
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
  for (const u of ["owner", "manager"] as const) {
    competence.held.set(`${DEMO.tenantId}:${DEMO.users[u].id}`, "current");
  }
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
    expect(text).toContain("No outcome recorded when the list was made: Paracetamol");
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

describe("hazard HZ-021 a write that began before the pack was built and committed after it", () => {
  it("hazard HZ-021 makes the pack stale, so the printed time never claims data it lacks", async () => {
    await pack();
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [DEMO.tenantId],
      );
      // Its time is when this transaction began, before the pack below is built.
      await client.query(
        `INSERT INTO contact (person_id, role, given_name, family_name, phone)
         VALUES ($1, 'next_of_kin', 'Contact', 'Example Late', '01632 960999')`,
        [ADA],
      );
      const built = await pack();
      await client.query("COMMIT");
      const after = await pack();
      expect(after.id).not.toBe(built.id);
      // Once seen, the pack is reused: no rebuild loop.
      expect((await pack()).id).toBe(after.id);
    } finally {
      client.release();
    }
  });
});

describe("hazard HZ-021 entries that may not be given, and an eMAR that cannot be read", () => {
  it("hazard HZ-021 prints a held entry's doses as on hold, never as due", async () => {
    const held = (
      await transcribe(
        {
          directions: {
            kind: "regular",
            schedule: {
              pattern: { kind: "every_day" },
              times: [{ time: "12:00", dose: { kind: "amount", quantity: 1, unit: TABLET } }],
            },
          },
        },
        DEV,
      )
    ).id;
    const checked = await send("owner", `/v1/medicines/${held}/check`, {
      method: "POST",
      body: {
        outcome: "differs_from_source",
        difference: "The strength differs from the prescription",
        comparedWithSource: true,
      },
    });
    expect(checked.status, await checked.clone().text()).toBe(200);
    const heldPrn = (
      await transcribe(
        {
          product: LACTULOSE,
          indication: "Constipation",
          directions: {
            kind: "when_required",
            dose: { kind: "amount", quantity: 15, unit: ML },
            maxQuantityPer24Hours: 30,
          },
        },
        DEV,
      )
    ).id;
    const prnChecked = await send("owner", `/v1/medicines/${heldPrn}/check`, {
      method: "POST",
      body: {
        outcome: "differs_from_source",
        difference: "The dose differs from the prescription",
        comparedWithSource: true,
      },
    });
    expect(prnChecked.status, await prnChecked.clone().text()).toBe(200);
    const page = (await pack()).pages.find((p) => p.personId === DEV);
    // A held when-required medicine is listed as on hold, never left off (slice 49 review).
    expect(page?.content.medicinesDue?.prn).toEqual([
      expect.objectContaining({ onHold: true, reason: "Constipation" }),
    ]);
    const doses = page?.content.medicinesDue?.due ?? [];
    expect(doses.length).toBeGreaterThan(0);
    expect(doses.every((d) => d.onHold === true)).toBe(true);
    expect(doses[0]?.notice).toMatch(/^Do not give: the check found a difference/);
    const r = await send("manager", `${packUrl}?format=pdf`);
    const text = pdfPages(new Uint8Array(await r.arrayBuffer()))
      .flat()
      .join(" ");
    expect(text).toContain("On hold on the eMAR, not to be given: Paracetamol");
    expect(text).toContain("On hold on the eMAR, not to be given: when required: Lactulose");
    const transfer = await json<TransferPack>(
      await send("manager", `/v1/people/${DEV}/transfer-pack`),
    );
    expect(transfer.content.medicines.items?.[0]?.status).toBe(
      "On hold on the home's eMAR: check found a difference.",
    );
  });

  it("hazard HZ-021 says the eMAR could not be read, never pointing at the paper MAR alone", async () => {
    // A regular medicine with no times on its schedule cannot be expanded into doses (slice 48).
    const broken = randomUUID();
    await asDemo((c) =>
      c.query(
        `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, transcribed_by, transcribed_at)
         VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Lactulose', '26643006', 'Oral', 'regular',
           'every_day', 'Dr A Example', now() - interval '2 days', 'prescription', 'Prescription',
           $4, now() - interval '2 days')`,
        [broken, CARL, LACTULOSE.vmpId, DEMO.users.manager.id],
      ),
    );
    const body = await pack();
    const carl = body.pages.find((p) => p.personId === CARL);
    const section = carl?.sections.find((s) => s.key === "medicines_due");
    expect(section?.status).toBe("unreadable");
    expect(section?.note).toMatch(/^Medicines could not be read from the eMAR/);
    expect(body.warnings).toContainEqual(
      expect.objectContaining({ personId: CARL, kind: "medicines_unreadable" }),
    );
    // Everyone else's medicines are still there, and the pack is built again on the next read.
    expect(
      body.pages.find((p) => p.personId === ADA)?.sections.find((s) => s.key === "medicines_due")
        ?.status,
    ).toBe("included");
    expect((await pack()).id).not.toBe(body.id);
    const audited = await asDemo((c) =>
      c.query<{ scope: { medicinesUnreadable?: string[] } }>(
        `SELECT scope FROM audit_event WHERE action = 'operations.downtime_pack.generated'
         AND resource_id = $1`,
        [body.id],
      ),
    );
    expect(audited.rows[0]?.scope.medicinesUnreadable).toEqual([CARL]);
  });

  it("hazard HZ-023 says on the first page when the eMAR could not be read", async () => {
    const r = await send("manager", `/v1/people/${CARL}/transfer-pack`);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = await json<TransferPack>(r);
    expect(body.attention?.map((a) => a.code)).toContain("medicines_emar_unreadable");
    expect(body.content.medicines.source).not.toBe("emar");
  });
});

describe("hazard HZ-003 a refused dose reaches the shift handover (slice 49, migration 0144)", () => {
  it("hazard HZ-003 hands over a dose refused on the eMAR as a refusal", async () => {
    const EVE = "0194d000-0000-7000-8600-000000000005";
    const at = new Date(
      Math.floor(
        Math.max(Date.now() - 30 * MINUTE, ukStartOfDay(ukDateOf(new Date())).getTime() + MINUTE) /
          MINUTE,
      ) * MINUTE,
    );
    const entry = await transcribe(
      {
        earlierDosesDueReason: "Due this morning; the paper MAR shows it was not given",
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [{ time: ukTime(at), dose: { kind: "amount", quantity: 1, unit: TABLET } }],
          },
        },
      },
      EVE,
    );
    const refused = await send("manager", `/v1/people/${EVE}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId: entry.id,
        dueAt: at.toISOString(),
        outcome: "refused",
        reason: { code: "declined" },
      },
    });
    expect(refused.status, await refused.clone().text()).toBe(201);
    const recordId = (await json<{ administration: { id: string } }>(refused)).administration.id;
    const compile = async () => {
      const r = await send("manager", `/v1/locations/${DEMO.locationId}/handovers`, {
        method: "POST",
        body: {},
      });
      expect([200, 201], await r.clone().text()).toContain(r.status);
      return json<{
        items: {
          sourceType: string;
          sourceId: string;
          kind: string;
          personId: string | null;
          summary: { key: string; params: Record<string, string> } | null;
        }[];
      }>(r);
    };
    const item = (await compile()).items.find((i) => i.sourceId === recordId);
    expect(item).toMatchObject({
      kind: "refusal",
      sourceType: "medication_administration",
      personId: EVE,
      summary: { key: "handover.summary.refusal", params: { chart: "medicine" } },
    });
  });
});

describe("the packs read a bounded administration history (slice 49 security review)", () => {
  it("reads the window and the latest given record of each medicine before it, never older ones", async () => {
    const FAY = "0194d000-0000-7000-8600-000000000006";
    const entry = await transcribe(
      {
        product: LACTULOSE,
        indication: "Constipation",
        directions: {
          kind: "when_required",
          dose: { kind: "amount", quantity: 15, unit: ML },
          maxQuantityPer24Hours: 30,
        },
      },
      FAY,
    );
    const given = await send("manager", `/v1/people/${FAY}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId: entry.id,
        outcome: "given",
        amount: { quantity: 15, unitCode: ML.code },
      },
    });
    expect(given.status, await given.clone().text()).toBe(201);
    const recent = (await json<{ administration: { id: string } }>(given)).administration.id;
    // Older copies of that record, written as they would have been (triggers off, as superuser).
    const copy = async (daysAgo: number, outcome: string) => {
      const id = randomUUID();
      await withAdminClient(async (c) => {
        await c.query("SET session_replication_role = replica");
        await c.query(
          `INSERT INTO medication_administration
           SELECT (jsonb_populate_record(NULL::medication_administration, to_jsonb(a) ||
             jsonb_build_object('id', $2::uuid, 'outcome', $3::text,
               'given_at', now() - make_interval(days => $4),
               'recorded_at', now() - make_interval(days => $4)))).*
           FROM medication_administration a WHERE a.id = $1`,
          [recent, id, outcome, daysAgo],
        );
        await c.query("SET session_replication_role = origin");
      }, h.db.name);
      return id;
    };
    const old = await copy(60, "given");
    const older = await copy(70, "given");
    await copy(50, "refused");
    const db = createDatabase(h.db.pool("harbour_owner"));
    const read = (since: Date) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${DEMO.tenantId}, true), set_config('app.scope', 'tenant', true)`,
        );
        return recentAdministrations(tx as unknown as Transaction, FAY, since);
      });
    const DAY = 24 * 60 * MINUTE;
    // The window holds today's record; before it, only the latest given record (60 days ago) comes,
    // never the older one or a refusal.
    expect((await read(new Date(Date.now() - 35 * DAY))).map((r) => r.id)).toEqual([old, recent]);
    const wider = (await read(new Date(Date.now() - 65 * DAY))).map((r) => r.id);
    expect(wider).toHaveLength(4);
    expect(wider[0]).toBe(older);
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
    expect(paracetamol?.status).toBe("Recorded on the home's eMAR as not yet checked.");
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

describe("scope and audit of the medicines in the packs (slice 49 security review)", () => {
  it("hazard HZ-011 never puts another home's people or medicines on a location-scoped builder's pack", async () => {
    const r = await send("owner", `/v1/people/${LODGE.personId}/medicines`, {
      method: "POST",
      body: {
        product: { ...PARACETAMOL, name: "Paracetamol 500mg tablets" },
        route: ORAL,
        prescriber: "Dr A Example",
        startsAt: ukStartOfDay(ukDateOf(new Date())).toISOString(),
        source: SOURCE,
        indication: "Lodge only",
        directions: {
          kind: "when_required",
          dose: { kind: "amount", quantity: 1, unit: TABLET },
          maxQuantityPer24Hours: 4,
        },
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    // The Registered Manager covers Harbour House only.
    const body = await pack();
    expect(body.pages.map((p) => p.personId)).not.toContain(LODGE.personId);
    expect(JSON.stringify(body)).not.toContain("Lodge only");
    expect((await send("manager", `/v1/locations/${LODGE.locationId}/downtime-pack`)).status).toBe(
      404,
    );
    expect((await send("manager", `/v1/people/${LODGE.personId}/transfer-pack`)).status).toBe(404);
  });

  it("hazard HZ-023 audits the transfer sent with the person, saying the eMAR could not be read", async () => {
    const person = await json<{ version: number }>(await send("manager", `/v1/people/${CARL}`));
    const created = await send("manager", `/v1/people/${CARL}/hospital-transfers`, {
      method: "POST",
      body: {
        leftAt: new Date().toISOString(),
        hospitalName: "Example General Hospital",
        sendItemIds: [],
        version: person.version,
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await json<{ id: string }>(created);
    const audited = await asDemo((c) =>
      c.query<{ scope: { medicinesEmarUnreadable?: boolean } }>(
        `SELECT scope FROM audit_event WHERE action = 'people.hospital_transfer.create'
         AND resource_id = $1`,
        [id],
      ),
    );
    expect(audited.rows[0]?.scope.medicinesEmarUnreadable).toBe(true);
  });
});
