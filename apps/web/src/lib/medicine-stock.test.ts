import { NewTemperatureReading, RecordDisposal, StockCount } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  balanceChip,
  disposalChip,
  entryUnitName,
  findDisposal,
  type MedicineOrder,
  mayCancelOrder,
  mayRecordTemperature,
  maySubmitOrder,
  openableEntries,
  orderChip,
  orderLineChoices,
  orderQuantityField,
  type PersonStock,
  rangeWords,
  readCelsius,
  readCount,
  readCycle,
  readDisposal,
  readingBreach,
  readingChip,
  readNewOrder,
  readOpenItem,
  readReading,
  readStockCount,
  readStockQuantityForm,
  readStorage,
  readSubmitOrder,
  STOCK_FIELD_FOR_PROBLEM,
  STOCK_PROBLEMS,
  stockManaged,
  stockShown,
  type TemperatureReading,
} from "./medicine-stock";

/**
 * Medicines stock, ordering, disposal and temperatures on the web (slice 55; MEDS-008;
 * medicines.md section 15): every state as an icon and a word, the forms read into the contract
 * with each mistake said at its field, and nothing worked out here that the API decides (HZ-132).
 * The translator returns the key and its values, so the words are checked by key.
 */

const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as Translator;

const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};
const ME = "0194d000-0000-7000-8000-000000000303";
const OTHER = "0194d000-0000-7000-8000-000000000302";
const P1 = "0194d000-0000-7000-8000-00000000b001";
const M1 = "0194d000-0000-7000-8000-00000000c001";
const M2 = "0194d000-0000-7000-8000-00000000c002";

describe("who sees and changes stock (the API's permissions)", () => {
  it.each([
    [["medicines.record.manage"], true, false, false],
    [["medicines.emar.administer"], true, false, true],
    [["medicines.stock.manage"], true, true, true],
    [["care.plan.read"], false, false, false],
  ])("%j", (permissions, shown, managed, records) => {
    expect(stockShown(permissions)).toBe(shown);
    expect(stockManaged(permissions)).toBe(managed);
    expect(mayRecordTemperature(permissions)).toBe(records);
  });
});

describe("an order's step is an icon and a word, never colour alone", () => {
  it.each([
    ["draft", "notApplicable", true, true],
    ["submitted", "due", false, true],
    ["part_received", "due", false, true],
    ["received", "done", false, false],
    ["cancelled", "notApplicable", false, false],
  ] as const)("%s", (status, chip, submit, cancel) => {
    const c = orderChip(status, t);
    expect(c.status).toBe(chip);
    expect(c.icon).toBeTruthy();
    expect(c.label).toContain(status);
    expect(maySubmitOrder(status)).toBe(submit);
    expect(mayCancelOrder(status)).toBe(cancel);
  });
});

const reading = (r: Partial<TemperatureReading>): TemperatureReading => ({
  id: "r",
  celsius: 5,
  minCelsius: null,
  maxCelsius: null,
  lowCelsius: 2,
  highCelsius: 8,
  outOfRange: false,
  taskId: null,
  recordedBy: ME,
  recordedAt: "2026-11-06T08:00:00Z",
  ...r,
});

describe("hazard HZ-132 a reading's state is the API's, shown as an icon and words", () => {
  it.each([
    ["in range", reading({}), null, "done"],
    ["too warm", reading({ celsius: 8.1, outOfRange: true }), "above", "overdue"],
    ["too cold", reading({ celsius: 1.9, outOfRange: true }), "below", "overdue"],
    [
      "the maximum since the last reading",
      reading({ celsius: 5, maxCelsius: 9.2, outOfRange: true }),
      "since_last",
      "overdue",
    ],
    [
      "a room has no minimum",
      reading({ celsius: -3, lowCelsius: null, highCelsius: 25, outOfRange: true }),
      "since_last",
      "overdue",
    ],
  ])("%s", (_, r, breach, status) => {
    expect(readingBreach(r)).toBe(breach);
    const chip = readingChip(r, t);
    expect(chip.status).toBe(status);
    expect(chip.icon).toBeTruthy();
    expect(chip.label.length).toBeGreaterThan(0);
  });

  it("never decides out of range itself: a reading at the edge the API found in range stays in range", () => {
    expect(readingChip(reading({ celsius: 8, outOfRange: false }), t).status).toBe("done");
  });

  it("says the range that applied, from the rate table as stored", () => {
    expect(rangeWords(reading({}), t)).toContain('"low":2');
    expect(rangeWords(reading({ lowCelsius: null, highCelsius: 25 }), t)).toContain("rangeUpTo");
  });
});

describe("hazard HZ-132 a temperature is read to one decimal place at most, never rounded", () => {
  it.each([
    ["5", 5],
    ["5.4", 5.4],
    ["-1.0", -1],
    ["0", 0],
    ["60", 60],
    ["-50", -50],
    ["8.04", null],
    ["1.95", null],
    ["61", null],
    ["-51", null],
    ["5,4", null],
    ["05", null],
    ["", null],
  ])("%s", (typed, value) => {
    expect(readCelsius(typed)).toBe(value);
  });

  it("reads a reading with its minimum and maximum into the contract", () => {
    const read = readReading(form({ celsius: "5.4", minCelsius: "3.0", maxCelsius: "" }), t);
    expect(read).toEqual({ ok: true, body: { celsius: 5.4, minCelsius: 3, maxCelsius: null } });
    if (read.ok) expect(NewTemperatureReading.safeParse(read.body).success).toBe(true);
  });

  it.each([
    [{ celsius: "" }, ["celsius"]],
    [{ celsius: "8.04" }, ["celsius"]],
    [{ celsius: "5", maxCelsius: "9.25" }, ["maxCelsius"]],
  ])("says each mistake at its field %j", (values, fields) => {
    const read = readReading(form(values), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual(fields);
  });
});

describe("hazard HZ-003 a balance below nought asks for a count, in words", () => {
  it.each([
    [-1, "overdue"],
    [0, null],
    [12.5, null],
  ])("%s", (balance, status) => {
    expect(balanceChip(balance, t)?.status ?? null).toBe(status);
  });
});

describe("a disposal's witness state is an icon and a word", () => {
  it.each([
    ["awaiting_witness", "due"],
    ["witnessed", "done"],
    ["no_witness", "done"],
  ] as const)("%s", (status, chip) => {
    expect(disposalChip(status, t).status).toBe(chip);
  });
});

describe("quantities and counts as typed", () => {
  it.each([
    ["0", 0],
    ["12", 12],
    ["1.125", 1.125],
    ["1.1255", null],
    ["007", null],
    ["-1", null],
    ["1000001", null],
  ])("count %s", (typed, value) => {
    expect(readCount(typed)).toBe(value);
  });

  it.each([
    [{ quantity: "28" }, "receipt", { quantity: 28, orderLineId: null }],
    [{ quantity: "28", orderLineId: M1 }, "receipt", { quantity: 28, orderLineId: M1 }],
    [{ quantity: "2", orderLineId: M1 }, "return", { quantity: 2, orderLineId: null }],
  ] as const)("reads %j as a %s", (values, kind, body) => {
    expect(readStockQuantityForm(form(values), t, kind)).toEqual({ ok: true, body });
  });

  it.each([
    [{ quantity: "0" }, ["quantity"]],
    [{ quantity: "" }, ["quantity"]],
    [{ quantity: "2", orderLineId: "line" }, ["orderLineId"]],
  ])("refuses %j", (values, fields) => {
    const read = readStockQuantityForm(form(values), t, "receipt");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual(fields);
  });
});

describe("rule 4 a count that differs from the balance needs a reason", () => {
  it.each([
    [
      "matches, no reason sent",
      { counted: "10", reason: "Some words" },
      10,
      { counted: 10, reason: null },
    ],
    [
      "differs, with a reason",
      { counted: "8", reason: "Two dropped" },
      10,
      { counted: 8, reason: "Two dropped" },
    ],
    ["nought counted", { counted: "0", reason: "All used" }, 3, { counted: 0, reason: "All used" }],
  ])("%s", (_, values, balance, body) => {
    const read = readStockCount(form(values), t, balance);
    expect(read).toEqual({ ok: true, body });
    if (read.ok) expect(StockCount.safeParse(read.body).success).toBe(true);
  });

  it.each([
    ["differs without a reason", { counted: "8" }, ["reason"]],
    ["a reason too short", { counted: "8", reason: "no" }, ["reason"]],
    ["nothing counted", { counted: "" }, ["counted"]],
  ])("%s", (_, values, fields) => {
    const read = readStockCount(form(values), t, 10);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual(fields);
  });
});

describe("rule 5 a disposal is witnessed by someone else, or says why no one could", () => {
  const base = { quantity: "2", reason: "dropped_or_spoilt" };
  it.each([
    [
      "a witness",
      { ...base, witnessed: "witness", witnessId: OTHER },
      { witnessId: OTHER, noWitnessReason: null },
    ],
    [
      "no witness, with why",
      { ...base, witnessed: "no_witness", noWitnessReason: "Night shift, alone on the floor" },
      { witnessId: null, noWitnessReason: "Night shift, alone on the floor" },
    ],
  ])("%s", (_, values, witness) => {
    const read = readDisposal(form(values), t, ME);
    expect(read).toEqual({
      ok: true,
      body: { quantity: 2, reason: "dropped_or_spoilt", note: null, ...witness },
    });
    if (read.ok) expect(RecordDisposal.safeParse(read.body).success).toBe(true);
  });

  it.each([
    ["the recorder as witness", { ...base, witnessed: "witness", witnessId: ME }, ["witnessId"]],
    ["no witness chosen", { ...base, witnessed: "witness" }, ["witnessId"]],
    [
      "why too short",
      { ...base, witnessed: "no_witness", noWitnessReason: "alone" },
      ["noWitnessReason"],
    ],
    ["neither", base, ["witnessed"]],
    ["no quantity or reason", { witnessed: "witness", witnessId: OTHER }, ["quantity", "reason"]],
    [
      "a reason not on the list",
      { ...base, reason: "lost", witnessed: "witness", witnessId: OTHER },
      ["reason"],
    ],
  ])("%s", (_, values, fields) => {
    const read = readDisposal(form(values), t, ME);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual(fields);
  });
});

describe("the cycle, orders and storage read into the contract", () => {
  it("reads the cycle's first day with the version read", () => {
    expect(
      readCycle(
        form({ "anchorOn-day": "2", "anchorOn-month": "11", "anchorOn-year": "2026" }),
        t,
        3,
      ),
    ).toEqual({ ok: true, body: { anchorOn: "2026-11-02", version: 3 } });
    expect(readCycle(form({}), t, null).ok).toBe(false);
  });

  const candidates = [
    { personId: P1, medicationId: M1 },
    { personId: P1, medicationId: M2 },
  ];
  const date = {
    "cycleStartsOn-day": "30",
    "cycleStartsOn-month": "11",
    "cycleStartsOn-year": "2026",
  };

  it("orders only the medicines given a quantity", () => {
    const read = readNewOrder(
      form({ ...date, [orderQuantityField(candidates[0] as never)]: "56" }),
      t,
      candidates,
    );
    expect(read).toEqual({
      ok: true,
      body: {
        cycleStartsOn: "2026-11-30",
        lines: [{ personId: P1, medicationId: M1, quantity: 56 }],
      },
    });
  });

  it.each([
    ["no quantity at all", date, ["lines"]],
    ["a quantity not a number", { ...date, [`qty-${P1}-${M2}`]: "lots" }, [`qty-${P1}-${M2}`]],
    ["no cycle date", { [`qty-${P1}-${M1}`]: "5" }, ["cycleStartsOn"]],
  ])("%s", (_, values, fields) => {
    const read = readNewOrder(form(values), t, candidates);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual(fields);
  });

  it.each([
    ["manual", true],
    ["pharmacy_port", true],
    ["fax", false],
  ])("submits via %s", (via, ok) => {
    expect(readSubmitOrder(form({ via }), t, 2).ok).toBe(ok);
  });

  it.each([
    [{ kind: "fridge", name: "Treatment room fridge" }, true],
    [{ kind: "room", name: "Ab" }, true],
    [{ kind: "freezer", name: "Freezer" }, false],
    [{ kind: "room", name: "A" }, false],
  ])("storage %j", (values, ok) => {
    expect(readStorage(form(values), t).ok).toBe(ok);
  });

  it("opens an item only from a chosen entry", () => {
    expect(readOpenItem(form({ medicationId: M1 }), t)).toEqual({
      ok: true,
      body: { medicationId: M1 },
    });
    expect(readOpenItem(form({}), t).ok).toBe(false);
  });
});

describe("what the pages offer", () => {
  const order = (status: MedicineOrder["status"], personId = P1, medicationId = M1) =>
    ({
      id: `o-${status}`,
      version: 1,
      cycleStartsOn: "2026-11-30",
      status,
      sentVia: null,
      pharmacyReference: null,
      submittedAt: null,
      lines: [
        {
          id: `l-${status}`,
          personId,
          medicationId,
          productName: "X",
          quantity: 28,
          unitCode: "u",
          received: 0,
        },
      ],
    }) as MedicineOrder;

  it("a receipt fills only an open order's line for this medicine", () => {
    const orders = [
      order("draft"),
      order("submitted"),
      order("part_received"),
      order("received"),
      order("cancelled"),
      order("submitted", P1, M2),
    ];
    expect(orderLineChoices(orders, P1, M1).map((l) => l.id)).toEqual([
      "l-submitted",
      "l-part_received",
    ]);
  });

  it("an item opens only from an entry in force without one", () => {
    const entries = [
      { id: M1, state: "checked" },
      { id: M2, state: "not_yet_checked" },
      { id: "m3", state: "stopped" },
      { id: "m4", state: "difference_found" },
    ];
    expect(openableEntries(entries, [{ medicationId: M1 }]).map((e) => e.id)).toEqual([M2, "m4"]);
  });

  it("counts in the entry's dose unit", () => {
    const unit = { code: "1", name: "tablet" };
    expect(
      entryUnitName({
        directions: { kind: "when_required", dose: { kind: "amount", quantity: 1, unit } },
      } as never),
    ).toBe("tablet");
    expect(
      entryUnitName({
        directions: { kind: "regular", schedule: { pattern: { kind: "every_day" }, times: [] } },
      } as never),
    ).toBeNull();
  });

  it("finds the disposal a witness page is about", () => {
    const stock = {
      items: [
        {
          id: "i1",
          movements: [{ id: "mv1", disposalId: "d1", change: -2 }],
        },
      ],
      controlledDrugs: [],
    } as unknown as PersonStock;
    expect(findDisposal(stock, "d1")?.movement.id).toBe("mv1");
    expect(findDisposal(stock, "d2")).toBeNull();
  });

  it("every refusal tied to a field is shown in the API's words", () => {
    for (const code of Object.keys(STOCK_FIELD_FOR_PROBLEM)) {
      expect(STOCK_PROBLEMS.has(code)).toBe(true);
    }
  });
});
