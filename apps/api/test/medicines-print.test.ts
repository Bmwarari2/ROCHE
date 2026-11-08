import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { type MarEntry, ukDateOf, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { marMonth } from "../src/routes/medicines-print";
import {
  type CdPrintEntry,
  cdRegisterLines,
  cdRegisterPrintedNotice,
} from "../src/services/cd-register-pdf";
import {
  doseCell,
  initialsOf,
  type MarDoseCell,
  type MarPrintInput,
  type MarRecord,
  marChartLines,
  marPrintEntries,
  marPrintedNotice,
  uniqueInitials,
} from "../src/services/mar-pdf";
import { type AdministrationRow, effective } from "../src/services/medicine-administrations";
import { createHarness, type Harness, OTHER } from "./support/harness";
import { pdfPages } from "./support/pdf-text";

/**
 * The printable MAR chart and controlled drugs register page (Phase 2 slice 50; MEDS-014;
 * medicines.md section 17). The chart is one person and one month with:
 * - the allergies;
 * - a key to the codes;
 * - every dose by day, with its outcome, the giver's initials, and covert and corrected marks;
 * - the printed time and "not the live record" on every page.
 *
 * The register page has every entry in order with its signatures and the corrections under the
 * entries they correct. Hazards: HZ-007 (the allergy section), HZ-122 (taken for the live record).
 */

const at = (iso: string) => new Date(iso);
const staff = (id: string | null) => (id === "u1" ? { name: "Ada Example", initials: "AE" } : null);
const cell = (o: Partial<MarDoseCell>): MarDoseCell => ({
  dueAt: at("2026-11-02T08:00:00Z"),
  date: "2026-11-02",
  time: "08:00",
  dayName: "Mon",
  notDue: false,
  record: null,
  ...o,
});
const printedAt = at("2026-11-06T10:00:00Z");

describe("hazard HZ-122 each dose's cell says what the record says, never more", () => {
  const rec = (o: Partial<MarRecord> = {}): MarRecord => ({
    outcome: "given",
    givenAt: at("2026-11-02T08:00:00Z"),
    by: "u1",
    covert: false,
    corrected: false,
    amount: null,
    reason: null,
    ...o,
  });
  it.each([
    ["given on time, with the giver's initials", { record: rec() }, "08:00 G AE"],
    [
      "given late, with the amount, covert and corrected",
      {
        record: rec({
          givenAt: at("2026-11-02T08:40:00Z"),
          amount: "2 tablet",
          covert: true,
          corrected: true,
        }),
      },
      "08:00 G at 08:40 2 tablet covert corrected AE",
    ],
    [
      "given after midnight, with the date",
      { record: rec({ givenAt: at("2026-11-03T00:15:00Z") }) },
      "08:00 G at 03/11/2026 00:15 AE",
    ],
    [
      "refused, with the reason, giver not named",
      { record: rec({ outcome: "refused", by: null, reason: "The person declined it" }) },
      "08:00 R (The person declined it) giver not named",
    ],
    ["past with no outcome", {}, "08:00 no outcome recorded"],
    ["not yet due when printed", { dueAt: at("2026-11-20T08:00:00Z") }, "08:00 not yet due"],
    [
      "before the entry was recorded",
      { notDue: true },
      "08:00 not due (before the entry was recorded)",
    ],
    [
      "a time in the hour the clocks go back, with its zone",
      { dueAt: at("2026-10-25T00:30:00Z"), date: "2026-10-25", time: "01:30" },
      "01:30 BST no outcome recorded",
    ],
  ] as const)("%s", (_, o, words) => {
    expect(doseCell(cell(o as Partial<MarDoseCell>), { staff, printedAt })).toBe(words);
  });

  it("makes initials unique on the chart, and from the name", () => {
    expect(initialsOf("Ada Example")).toBe("AE");
    expect(initialsOf("Mary Jane Ann Example")).toBe("MJA");
    const map = uniqueInitials([
      { id: "a", name: "Ann Example" },
      { id: "b", name: "Ada Example" },
      { id: "c", name: "Ben Sample" },
    ]);
    expect([map.get("b"), map.get("a"), map.get("c")]).toEqual(["AE1", "AE2", "BS"]);
  });
});

const TABLET = { code: "428673006", name: "tablet" };
function marEntry(o: Partial<MarEntry> = {}): MarEntry {
  return {
    id: "e1",
    version: 1,
    origin: "transcribed",
    state: "checked",
    personId: "p1",
    product: { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" },
    route: { code: "26643006", name: "Oral" },
    directions: {
      kind: "regular",
      schedule: {
        pattern: { kind: "every_day" },
        times: [{ time: "22:00", dose: { kind: "amount", quantity: 1, unit: TABLET } }],
      },
    },
    tags: [],
    minimumIntervalMinutes: null,
    indication: null,
    specialInstructions: null,
    prescriber: "Dr A Example",
    startsAt: at("2026-10-01T00:00:00Z"),
    stopsAt: null,
    reviewOn: null,
    source: { kind: "prescription", reference: "FP10", documentId: null },
    transcribedBy: "u9",
    transcribedAt: at("2026-09-30T08:00:00Z"),
    replacesId: null,
    secondCheck: {
      by: "u8",
      at: at("2026-09-30T09:00:00Z"),
      outcome: "matches_source",
      difference: null,
    },
    stop: null,
    replacedById: null,
    replacedFrom: null,
    reanchor: null,
    withdrawn: null,
    correctedPartWayThrough: null,
    earlierDosesDue: null,
    ...o,
  } as MarEntry;
}
function row(o: Partial<AdministrationRow>): AdministrationRow {
  return {
    id: "r1",
    medicationId: "e1",
    dueAt: null,
    outcome: "given",
    reasonCode: null,
    quantity: "1",
    unitCode: TABLET.code,
    givenAt: at("2026-10-31T22:00:00Z"),
    administeredBy: "u1",
    covert: false,
    supersedesId: null,
    ...o,
  } as AdministrationRow;
}

describe("hazard HZ-122 hazard HZ-004 which records reach the month's chart (clinical review B1, B2)", () => {
  const october = marMonth("2026-10");
  const november = marMonth("2026-11");
  const due = at("2026-10-31T22:00:00Z");
  const cellOn = (entries: ReturnType<typeof marPrintEntries>, iso: string) =>
    entries[0]?.doses.find((d) => d.dueAt.toISOString() === iso);

  it("puts a dose due on 31/10 and given after midnight on the October chart, not lost", () => {
    const rows = [row({ dueAt: due, givenAt: at("2026-11-01T00:15:00Z") })];
    const oct = marPrintEntries([marEntry()], rows, october, printedAt);
    expect(cellOn(oct, due.toISOString())?.record?.outcome).toBe("given");
    const nov = marPrintEntries([marEntry()], rows, november, printedAt);
    expect(nov[0]?.unmatched).toEqual([]);
  });

  it("shows the correction that stands, though it was made in the next month", () => {
    const original = row({ id: "r1", dueAt: due, givenAt: at("2026-10-31T22:05:00Z") });
    const correction = row({
      id: "r2",
      dueAt: due,
      outcome: "refused",
      reasonCode: "declined",
      quantity: null,
      givenAt: at("2026-11-01T00:10:00Z"),
      supersedesId: "r1",
    });
    const standing = effective([original, correction]);
    const oct = marPrintEntries([marEntry()], standing, october, printedAt);
    expect(cellOn(oct, due.toISOString())?.record).toMatchObject({
      outcome: "refused",
      corrected: true,
      reason: "The person declined it",
    });
  });

  it("prints a record with no dose time on the chart, never dropping it", () => {
    const odd = row({
      id: "r3",
      dueAt: at("2026-10-15T12:00:00Z"),
      givenAt: at("2026-10-15T12:05:00Z"),
    });
    const oct = marPrintEntries([marEntry()], [odd], october, printedAt);
    expect(oct[0]?.unmatched.map((r) => r.outcome)).toEqual(["given"]);
    const text = marChartLines({ ...chartInput(), entries: oct }).map((l) => l.text);
    expect(text.join("\n")).toContain(
      "Recorded with no dose time on this chart: 15/10/2026 13:05 G 1 tablet AE",
    );
  });
});

function chartInput(o: Partial<MarPrintInput> = {}): MarPrintInput {
  return {
    person: {
      name: "Ada Example",
      preferredName: "Addie",
      dateOfBirth: "1938-02-01",
      nhsNumber: "9990000018",
      locationName: "Harbour House",
    },
    month: {
      label: "November 2026",
      from: at("2026-11-01T00:00:00Z"),
      to: at("2026-12-01T00:00:00Z"),
    },
    allergies: {
      status: "has_allergies",
      allergies: [
        { substance: "Penicillin", reaction: "Rash", severity: "moderate" },
        { substance: "Latex", reaction: null, severity: "severe" },
      ],
    },
    communication: {
      status: "recorded",
      needs: [{ code: "large_print", display: "Large print", preferredFormat: "" }],
      confirmedBy: null,
      confirmedAt: null,
    },
    entries: [
      {
        productName: "Paracetamol 500mg tablets",
        version: 1,
        route: "Oral",
        directions: "1 tablet every day at 08:00",
        kind: "regular",
        startsAt: at("2026-11-01T00:00:00Z"),
        endsAt: null,
        prescriber: "Dr A Example",
        status: "Checked",
        timeCritical: true,
        doses: [
          cell({
            record: {
              outcome: "given",
              givenAt: at("2026-11-02T08:00:00Z"),
              by: "u1",
              covert: true,
              corrected: false,
              amount: null,
              reason: null,
            },
          }),
        ],
        prnRecords: [],
        unmatched: [],
      },
      {
        productName: "Lactulose",
        version: 2,
        route: "Oral",
        directions: "15 ml when required",
        kind: "when_required",
        startsAt: at("2026-11-01T00:00:00Z"),
        endsAt: null,
        prescriber: "Dr A Example",
        status: "Not yet checked",
        timeCritical: false,
        doses: [],
        prnRecords: [],
        unmatched: [],
      },
    ],
    staff,
    printedAt,
    ...o,
  };
}

describe("hazard HZ-007 hazard HZ-122 the chart's lines", () => {
  const text = (i: MarPrintInput) => marChartLines(i).map((l) => l.text);

  it("says when it was printed and that it is not the live record, first, and who it is for", () => {
    const lines = text(chartInput());
    expect(lines[1]).toBe(marPrintedNotice(printedAt));
    expect(marPrintedNotice(printedAt)).toContain("This is not the live record");
    expect(lines[2]).toBe(
      "Ada Example (known as Addie). Born 01/02/1938. NHS number 999 000 0018. Harbour House.",
    );
  });

  it("lists every allergy, most severe first, and never shows unknown as none", () => {
    const lines = text(chartInput());
    const latex = lines.findIndex((l) => l.startsWith("Latex"));
    expect(latex).toBeGreaterThan(-1);
    expect(lines.findIndex((l) => l.startsWith("Penicillin"))).toBeGreaterThan(latex);
    expect(text(chartInput({ allergies: { status: "unknown" } }))).toContain(
      "Allergy status not recorded. Find out before giving any medicine.",
    );
    expect(text(chartInput({ allergies: { status: "has_allergies", allergies: [] } }))).toContain(
      "Allergies recorded, but none is listed. Check the record.",
    );
  });

  it("shows the communication needs, and says when they are not recorded", () => {
    expect(text(chartInput())).toContain("Large print");
    expect(text(chartInput({ communication: { status: "not_recorded" } }))).toContain(
      "Communication needs not recorded. Ask the person or their family.",
    );
  });

  it("keys every code, marks time-critical, the version and covert, and names the staff", () => {
    const lines = text(chartInput());
    expect(lines).toContain("G: given");
    expect(lines).toContain("Time-critical: Paracetamol 500mg tablets, Oral (version 1)");
    expect(lines).toContain("Mon 02/11/2026: 08:00 G covert AE");
    expect(lines).toContain("AE: Ada Example");
    expect(lines).toContain("No dose recorded this month.");
  });

  it("says when nothing was on the eMAR, never an empty page", () => {
    expect(text(chartInput({ entries: [] }))).toContain("No medicine was on the eMAR this month.");
  });
});

describe("hazard HZ-122 the month in UK time", () => {
  it.each([
    ["2026-03", "2026-03-01T00:00:00.000Z", "2026-03-31T23:00:00.000Z", "March 2026"],
    ["2026-10", "2026-09-30T23:00:00.000Z", "2026-11-01T00:00:00.000Z", "October 2026"],
    ["2026-12", "2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "December 2026"],
  ])("%s", (month, from, to, label) => {
    const m = marMonth(month);
    expect([m.from.toISOString(), m.to.toISOString(), m.label]).toEqual([from, to, label]);
  });
});

describe("hazard HZ-122 the register page's lines (clinical review B3)", () => {
  it("prints every entry in register order, a correction of a correction too, with signatures", () => {
    const entry = (o: Partial<CdPrintEntry>): CdPrintEntry => ({
      id: "e",
      seq: 1,
      movement: "receipt",
      quantity: 0,
      balanceAfter: 0,
      correctsId: null,
      corrects: null,
      reason: null,
      counterparty: null,
      reference: null,
      occurredAt: "2026-11-01T09:00:00Z",
      recorded: { id: "u1", at: "2026-11-01T09:01:00Z" },
      witnessId: "u2",
      noWitnessReason: null,
      ...o,
    });
    const entries = [
      entry({
        id: "e1",
        seq: 1,
        quantity: 100,
        balanceAfter: 100,
        counterparty: "Example Pharmacy",
        reference: "INV 1",
      }),
      entry({
        id: "e2",
        seq: 2,
        movement: "administration",
        quantity: -5,
        balanceAfter: 95,
        witnessId: null,
        noWitnessReason: "Night shift, one nurse",
      }),
      entry({
        id: "e3",
        seq: 3,
        movement: "correction",
        correctsId: "e1",
        corrects: "detail",
        reason: "Wrong invoice number",
        balanceAfter: 95,
      }),
      entry({
        id: "e4",
        seq: 4,
        movement: "correction",
        correctsId: "e3",
        corrects: "detail",
        reason: "Still the wrong number",
        balanceAfter: 95,
      }),
    ];
    const lines = cdRegisterLines({
      person: {
        name: "Ada Example",
        preferredName: null,
        dateOfBirth: null,
        nhsNumber: null,
        locationName: "Harbour House",
      },
      communication: { status: "none_identified", confirmedBy: "u1", confirmedAt: printedAt },
      page: { productName: "Morphine 10mg/5ml oral solution", unitName: "ml", balance: 95 },
      entries,
      stockChecks: [
        {
          counted: 95,
          expected: 95,
          resultInWords: "Balanced",
          reason: null,
          checked: { id: "u1", at: "2026-11-04T09:00:00Z" },
          witnessId: "u2",
          noWitnessReason: null,
        },
      ],
      people: [
        { id: "u1", name: "Ada Example" },
        { id: "u2", name: "Ben Example" },
      ],
      printedAt,
    }).map((l) => l.text);
    const printed = lines.filter((l) => /^\d+\. /.test(l));
    expect(printed).toHaveLength(entries.length);
    expect(printed.map((l) => l.split(".")[0])).toEqual(["1", "2", "3", "4"]);
    expect(printed[0]).toContain("Corrected by entry 3.");
    expect(printed[3]).toContain("Corrects the detail of entry 3.");
    expect(lines.join("\n")).toContain("witnessed by Ben Example");
    expect(lines.join("\n")).toContain("no witness: Night shift, one nurse");
    expect(lines.join("\n")).toContain("Balanced. Counted by Ada Example");
    // The register's own notice, never the eMAR's (#200 review): it says which register is the record.
    expect(lines[1]).toBe(cdRegisterPrintedNotice(printedAt));
    expect(lines[1]).toContain("This is not the live record");
    expect(lines[1]).not.toContain("eMAR");
    expect(lines).toContain("No communication needs identified.");
  });
});

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const competence = fixedCompetence();
const send = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

beforeAll(async () => {
  h = await createHarness();
  (h.handle.services as { medicines: { competence: unknown } }).medicines.competence = competence;
  competence.held.set(`${DEMO.tenantId}:${DEMO.users.manager.id}`, "current");
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-122 hazard HZ-007 the printed MAR through the API", () => {
  it("prints the month with the allergies, the doses and the notice on every page, and audits it", async () => {
    const now = new Date();
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(
      new Date(
        Math.max(now.getTime() - 30 * 60_000, ukStartOfDay(ukDateOf(now)).getTime() + 60_000),
      ),
    );
    const r = await send("manager", `/v1/people/${ADA}/medicines`, {
      method: "POST",
      body: {
        product: { vmpId: "90000011000001104", ampId: null, name: "Paracetamol 500mg tablets" },
        route: { code: "26643006", name: "Oral" },
        prescriber: "Dr A Example",
        startsAt: ukStartOfDay(ukDateOf(now)).toISOString(),
        source: { kind: "prescription", reference: "Prescription, Dr A Example" },
        earlierDosesDueReason: "Due this morning and not given before it was transcribed",
        directions: {
          kind: "regular",
          schedule: {
            pattern: { kind: "every_day" },
            times: [{ time, dose: { kind: "amount", quantity: 1, unit: TABLET } }],
          },
        },
      },
    });
    expect(r.status, await r.clone().text()).toBe(201);
    const { id: entryId } = (await r.json()) as { id: string };
    const round = (await (await send("manager", `/v1/people/${ADA}/medicine-round`)).json()) as {
      doses: { entryId: string; dueAt: string }[];
    };
    const dueAt = round.doses.find((d) => d.entryId === entryId)?.dueAt;
    const given = await send("manager", `/v1/people/${ADA}/medicine-administrations`, {
      method: "POST",
      body: {
        id: randomUUID(),
        entryId,
        dueAt,
        outcome: "given",
        amount: { quantity: 1, unitCode: TABLET.code },
        timingReason: "Given after the transcription this morning",
      },
    });
    expect(given.status, await given.clone().text()).toBe(201);

    const month = ukDateOf(now).slice(0, 7);
    const pdf = await send("manager", `/v1/people/${ADA}/mar/print?month=${month}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toContain("no-store");
    const pages = pdfPages(new Uint8Array(await pdf.arrayBuffer()));
    const text = pages.flat().join("\n");
    for (const page of pages) expect(page.join(" ")).toContain("This is not the live record");
    expect(text).toContain("Paracetamol 500mg tablets, Oral");
    expect(text).toMatch(/ G (at \S+ )?1 tablet [A-Z]{1,3}\d?/);
    expect(text).toContain("Allergies");
    expect(text).toContain("Staff initials on this chart");

    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [DEMO.tenantId],
      );
      const { rows } = await client.query<{ scope: { month?: string } }>(
        "SELECT scope FROM audit_event WHERE action = 'medicines.mar.printed' AND resource_id = $1",
        [ADA],
      );
      await client.query("COMMIT");
      expect(rows.map((row) => row.scope.month)).toContain(month);
    } finally {
      client.release();
    }
  });

  it("hazard HZ-011 refuses a malformed month and another organisation's member", async () => {
    expect((await send("manager", `/v1/people/${ADA}/mar/print?month=2026-13`)).status).toBe(422);
    expect((await send("manager", `/v1/people/${ADA}/mar/print`)).status).toBe(422);
    // Another organisation's member never reaches this person's chart.
    const other = await h.request(`/v1/people/${ADA}/mar/print?month=2026-11`, {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
    });
    expect([403, 404]).toContain(other.status);
  });

  it("finds no register page that does not exist", async () => {
    expect((await send("manager", `/v1/controlled-drugs/pages/${randomUUID()}/print`)).status).toBe(
      404,
    );
  });
});

describe("hazard HZ-122 hazard HZ-011 the register page through the API", () => {
  it("prints every entry with its signatures and the notice on every page, audits it, and keeps it in its organisation", async () => {
    const entryId = randomUUID();
    await asDemo(async (c) => {
      await c.query(
        `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, transcribed_by, transcribed_at, cd_schedule)
         VALUES ($1, $2, $1, 1, 'transcribed', '90000061000001101', 'Morphine sulfate 10mg tablets',
           '26643006', 'Oral', 'regular', 'every_day', 'Dr A Example', now() - interval '1 day',
           'prescription', 'Prescription', $3, now() - interval '1 day', '2')`,
        [entryId, ADA, DEMO.users.manager.id],
      );
      await c.query(
        `INSERT INTO medication_schedule (medication_id, person_id, position, time, dose_kind,
           quantity, unit_code, unit_name)
         VALUES ($1, $2, 0, '20:00', 'amount', 1, '428673006', 'tablet')`,
        [entryId, ADA],
      );
    });
    competence.held.set(`${DEMO.tenantId}:${DEMO.users.carer.id}`, "current");
    const opened = await send("manager", `/v1/people/${ADA}/controlled-drugs/pages`, {
      method: "POST",
      body: { entryId },
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const pageId = ((await opened.json()) as { id: string }).id;
    const signed = await send("carer", `/v1/controlled-drugs/pages/${pageId}/witness-assertions`, {
      method: "POST",
      body: { movement: "receipt", quantity: 28, recorderId: DEMO.users.manager.id },
    });
    expect(signed.status, await signed.clone().text()).toBe(201);
    const received = await send("manager", `/v1/controlled-drugs/pages/${pageId}/entries`, {
      method: "POST",
      body: {
        movement: "receipt",
        quantity: 28,
        counterparty: "Example Pharmacy",
        reference: "Delivery note 1001",
        witness: { witnessAssertionId: ((await signed.json()) as { id: string }).id },
      },
    });
    expect(received.status, await received.clone().text()).toBe(201);

    const pdf = await send("manager", `/v1/controlled-drugs/pages/${pageId}/print`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const pages = pdfPages(new Uint8Array(await pdf.arrayBuffer()));
    for (const page of pages) expect(page.join(" ")).toContain("This is not the live record");
    const text = pages.flat().join(" ");
    expect(text).toContain("1. Received +28 tablet, balance 28 tablet.");
    expect(text).toContain("Example Pharmacy");
    expect(text).toMatch(/witnessed by \S/);
    expect(text).toContain("No stock check on this page.");

    const audited = await asDemo((c) =>
      c.query(
        "SELECT 1 FROM audit_event WHERE action = 'medicines.cd.printed' AND resource_id = $1",
        [pageId],
      ),
    );
    expect(audited.rows).toHaveLength(1);
    const other = await h.request(`/v1/controlled-drugs/pages/${pageId}/print`, {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
    });
    expect([403, 404]).toContain(other.status);
  });

  it.each(["0050-01", "1999-12", "2999-01"])(
    "refuses the month %s at the edge of the UK clock",
    async (month) => {
      expect((await send("manager", `/v1/people/${ADA}/mar/print?month=${month}`)).status).toBe(
        422,
      );
    },
  );
});

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
