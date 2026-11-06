import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { ukDateOf, ukStartOfDay } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedCompetence } from "../src/integrations/medicines-ports";
import { marMonth } from "../src/routes/medicines-print";
import { cdRegisterLines } from "../src/services/cd-register-pdf";
import {
  doseCell,
  initialsOf,
  type MarDoseCell,
  type MarPrintInput,
  marChartLines,
  marPrintedNotice,
} from "../src/services/mar-pdf";
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
  it.each([
    [
      "given, with the giver's initials",
      {
        record: {
          outcome: "given",
          givenAt: printedAt,
          by: "u1",
          covert: false,
          corrected: false,
          amount: null,
        },
      },
      "08:00 G AE",
    ],
    [
      "given covertly and corrected",
      {
        record: {
          outcome: "given",
          givenAt: printedAt,
          by: "u1",
          covert: true,
          corrected: true,
          amount: null,
        },
      },
      "08:00 G covert corrected AE",
    ],
    [
      "refused by someone not named",
      {
        record: {
          outcome: "refused",
          givenAt: printedAt,
          by: null,
          covert: false,
          corrected: false,
          amount: null,
        },
      },
      "08:00 R",
    ],
    ["past with no outcome", {}, "08:00 no outcome recorded"],
    ["not yet due when printed", { dueAt: at("2026-11-20T08:00:00Z") }, "08:00 not yet due"],
    [
      "before the entry was recorded",
      { notDue: true },
      "08:00 not due (before the entry was recorded)",
    ],
  ] as const)("%s", (_, o, words) => {
    expect(doseCell(cell(o as Partial<MarDoseCell>), { staff, printedAt })).toBe(words);
  });

  it("makes initials from the name", () => {
    expect(initialsOf("Ada Example")).toBe("AE");
    expect(initialsOf("Mary Jane Ann Example")).toBe("MJA");
  });
});

describe("hazard HZ-007 hazard HZ-122 the chart's lines", () => {
  const input = (o: Partial<MarPrintInput> = {}): MarPrintInput => ({
    person: {
      name: "Ada Example",
      dateOfBirth: "1938-02-01",
      nhsNumber: "9990000018",
      room: null,
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
    entries: [
      {
        productName: "Paracetamol 500mg tablets",
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
              givenAt: printedAt,
              by: "u1",
              covert: true,
              corrected: false,
              amount: null,
            },
          }),
        ],
        prnRecords: [],
      },
      {
        productName: "Lactulose",
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
      },
    ],
    staff,
    printedAt,
    ...o,
  });
  const text = (i: MarPrintInput) => marChartLines(i).map((l) => l.text);

  it("says when it was printed and that it is not the live record, first", () => {
    expect(text(input())[1]).toBe(marPrintedNotice(printedAt));
    expect(marPrintedNotice(printedAt)).toContain("This is not the live record");
  });

  it("lists every allergy, most severe first, and never shows unknown as none", () => {
    const lines = text(input());
    const latex = lines.findIndex((l) => l.startsWith("Latex"));
    expect(latex).toBeGreaterThan(-1);
    expect(lines.findIndex((l) => l.startsWith("Penicillin"))).toBeGreaterThan(latex);
    expect(text(input({ allergies: { status: "unknown" } }))).toContain(
      "Allergy status not recorded. Find out before giving any medicine.",
    );
  });

  it("keys every code, marks time-critical and covert, and names the staff by initials", () => {
    const lines = text(input());
    expect(lines.join("\n")).toContain("G given; R refused; N not given");
    expect(lines).toContain("Time-critical: Paracetamol 500mg tablets, Oral");
    expect(lines).toContain("Mon 02/11/2026: 08:00 G covert AE");
    expect(lines).toContain("AE Ada Example");
    expect(lines).toContain("No dose recorded this month.");
  });

  it("says when nothing was on the eMAR, never an empty page", () => {
    expect(text(input({ entries: [] }))).toContain("No medicine was on the eMAR this month.");
  });
});

describe("the month in UK time", () => {
  it.each([
    ["2026-03", "2026-03-01T00:00:00.000Z", "2026-03-31T23:00:00.000Z", "March 2026"],
    ["2026-10", "2026-09-30T23:00:00.000Z", "2026-11-01T00:00:00.000Z", "October 2026"],
    ["2026-12", "2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "December 2026"],
  ])("%s", (month, from, to, label) => {
    const m = marMonth(month);
    expect([m.from.toISOString(), m.to.toISOString(), m.label]).toEqual([from, to, label]);
  });
});

describe("hazard HZ-122 the register page's lines", () => {
  it("puts each correction under its entry, with signatures and stock checks in words", () => {
    const lines = cdRegisterLines({
      person: {
        name: "Ada Example",
        dateOfBirth: null,
        nhsNumber: null,
        locationName: "Harbour House",
      },
      page: { productName: "Morphine 10mg/5ml oral solution", unitName: "ml", balance: 95 },
      entries: [
        {
          id: "e1",
          seq: 1,
          movement: "receipt",
          quantity: 100,
          balanceAfter: 100,
          correctsId: null,
          corrects: null,
          reason: null,
          counterparty: "Example Pharmacy",
          reference: "INV 1",
          occurredAt: "2026-11-01T09:00:00Z",
          recorded: { id: "u1", at: "2026-11-01T09:01:00Z" },
          witnessId: "u2",
          noWitnessReason: null,
        },
        {
          id: "e2",
          seq: 2,
          movement: "administration",
          quantity: -5,
          balanceAfter: 95,
          correctsId: null,
          corrects: null,
          reason: null,
          counterparty: null,
          reference: null,
          occurredAt: "2026-11-02T09:00:00Z",
          recorded: { id: "u1", at: "2026-11-02T09:01:00Z" },
          witnessId: null,
          noWitnessReason: "Night shift, one nurse",
        },
        {
          id: "e3",
          seq: 3,
          movement: "correction",
          quantity: 0,
          balanceAfter: 95,
          correctsId: "e1",
          corrects: "detail",
          reason: "Wrong invoice number",
          counterparty: null,
          reference: "INV 2",
          occurredAt: "2026-11-03T09:00:00Z",
          recorded: { id: "u1", at: "2026-11-03T09:01:00Z" },
          witnessId: "u2",
          noWitnessReason: null,
        },
      ],
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
    const receipt = lines.findIndex((l) => l.startsWith("1. Received +100 ml"));
    expect(lines[receipt + 1]).toMatch(
      /^ {4}Correction: 3\. Correction 0 ml.*Corrects the detail of entry 1\./,
    );
    expect(lines.join("\n")).toContain("witnessed by Ben Example");
    expect(lines.join("\n")).toContain("no witness: Night shift, one nurse");
    expect(lines.join("\n")).toContain("Balanced. Counted by Ada Example");
    expect(lines[1]).toBe(marPrintedNotice(printedAt));
  });
});

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const TABLET = { code: "428673006", name: "tablet" };
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
    expect(text).toMatch(/G [A-Z]{1,3}/);
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
