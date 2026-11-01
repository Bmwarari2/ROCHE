import { describe, expect, it } from "vitest";
import {
  type CdEntry,
  cdShown,
  countOverdue,
  movementChip,
  readCdEntry,
  readCdQuantity,
  readCorrection,
  readStockCheck,
  readWitness,
  stockCheckChip,
  withCorrectionsBeside,
} from "./controlled-drugs";
import { t } from "./i18n";

/** The controlled drugs register screens (MEDS-005; medicines.md section 15). */

const A = "0194d000-0000-7000-8000-0000000000a1";
const B = "0194d000-0000-7000-8000-0000000000a2";
const SIG = "0194d000-0000-7000-8000-0000000000c1";
const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
const entry = (over: Partial<CdEntry>): CdEntry =>
  ({
    id: A,
    seq: 1,
    movement: "receipt",
    quantity: 28,
    balanceAfter: 28,
    correctsId: null,
    corrects: null,
    reason: null,
    counterparty: null,
    reference: null,
    occurredAt: "2026-11-01T09:00:00Z",
    recorded: { id: A, at: "2026-11-01T09:00:00Z" },
    witnessId: B,
    noWitnessReason: null,
    flags: [],
    administrationId: null,
    correctedBy: [],
    ...over,
  }) as CdEntry;

describe("movements and results, each as an icon and a word", () => {
  it.each([
    ["receipt", "Received"],
    ["administration", "Given"],
    ["disposal", "Disposed of"],
    ["transfer_out", "Returned to the pharmacy"],
    ["destruction", "Destroyed"],
    ["correction", "Correction"],
  ] as const)("shows %s as %s", (movement, word) => {
    const chip = movementChip(movement, t);
    expect(chip.label).toBe(word);
    expect(chip.icon).toBeTruthy();
  });

  it("shows a count's result in the API's words, balanced or not", () => {
    expect(stockCheckChip({ difference: 0, resultInWords: "Balanced" })).toMatchObject({
      status: "done",
      label: "Balanced",
    });
    expect(stockCheckChip({ difference: -2, resultInWords: "2 tablets short" })).toMatchObject({
      status: "overdue",
      label: "2 tablets short",
    });
  });

  it("says a count is overdue once its due time has passed", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(countOverdue("2026-11-01T11:59:00Z", now)).toBe(true);
    expect(countOverdue("2026-11-02T12:00:00Z", now)).toBe(false);
    expect(countOverdue(null, now)).toBe(false);
  });

  it("opens the tab to the API's readers", () => {
    expect(cdShown(["medicines.cd.witness"])).toBe(true);
    expect(cdShown(["care.plan.read"])).toBe(true);
    expect(cdShown(["care.note.read"])).toBe(false);
  });
});

describe("hazard HZ-116 corrections sit beside the entry they correct; nothing is reordered or hidden", () => {
  it("places each correction under its entry, in page order, and keeps every entry", () => {
    const e1 = entry({ id: "e1", seq: 1 });
    const e2 = entry({ id: "e2", seq: 2, movement: "disposal", quantity: 1, balanceAfter: 27 });
    const c3 = entry({
      id: "c3",
      seq: 3,
      movement: "correction",
      correctsId: "e1",
      corrects: "quantity",
      quantity: -1,
      balanceAfter: 26,
    });
    const c4 = entry({
      id: "c4",
      seq: 4,
      movement: "correction",
      correctsId: "c3",
      corrects: "detail",
    });
    const rows = withCorrectionsBeside([e2, c4, e1, c3]);
    expect(rows.map((r) => [r.entry.id, r.depth])).toEqual([
      ["e1", 0],
      ["c3", 1],
      ["c4", 2],
      ["e2", 0],
    ]);
    // The balance shown is always the API's, never added up here.
    expect(rows.find((r) => r.entry.id === "c3")?.entry.balanceAfter).toBe(26);
  });
});

describe("reading the forms", () => {
  it.each([
    ["28", false, 28],
    ["0.5", false, 0.5],
    ["-2", true, -2],
  ] as const)("reads %s (signed %s) as %s", (raw, signed, value) => {
    expect(readCdQuantity(raw, signed)).toBe(value);
  });
  it.each(["-2", "007", "1.2345", "two", ""])("refuses %j unsigned", (raw) => {
    expect(readCdQuantity(raw)).toBeNull();
  });

  it("hazard HZ-115 lets a witness sign only for someone else, offered by the API", () => {
    const recorders = new Set([A]);
    expect(
      readWitness(form({ movement: "receipt", quantity: "28", recorderId: A }), t, recorders),
    ).toEqual({
      ok: true,
      body: { movement: "receipt", quantity: 28, administrationId: null, recorderId: A },
    });
    expect(
      readWitness(form({ movement: "receipt", quantity: "28", recorderId: B }), t, recorders),
    ).toMatchObject({ ok: false, errors: { recorderId: expect.any(String) } });
  });

  it("hazard HZ-115 records with a waiting signature, or a reason only where allowed and never for a destruction", () => {
    const waiting = new Set([SIG]);
    const base = { movement: "receipt", quantity: "28", counterparty: "Example Pharmacy" };
    expect(
      readCdEntry(form({ ...base, witness: SIG }), t, { waiting, loneAllowed: false }),
    ).toMatchObject({ ok: true, body: { witness: { witnessAssertionId: SIG }, occurredAt: null } });
    expect(
      readCdEntry(form({ ...base, witness: "none", noWitnessReason: "Alone" }), t, {
        waiting,
        loneAllowed: false,
      }),
    ).toMatchObject({ ok: false, errors: { witness: expect.any(String) } });
    expect(
      readCdEntry(form({ ...base, witness: "none", noWitnessReason: "Alone at night" }), t, {
        waiting,
        loneAllowed: true,
      }),
    ).toMatchObject({ ok: true, body: { witness: { noWitnessReason: "Alone at night" } } });
    expect(
      readCdEntry(
        form({ ...base, movement: "destruction", witness: "none", noWitnessReason: "Alone" }),
        t,
        { waiting, loneAllowed: true },
      ),
    ).toMatchObject({ ok: false, errors: { witness: expect.any(String) } });
  });

  it("reads a correction of the quantity as a signed change, and of a detail as no change", () => {
    const options = { entries: new Set([A]), waiting: new Set([SIG]), loneAllowed: false };
    expect(
      readCorrection(
        form({
          correctsId: A,
          corrects: "quantity",
          quantity: "-2",
          reason: "Miscounted",
          witness: SIG,
        }),
        t,
        options,
      ),
    ).toMatchObject({
      ok: true,
      body: { movement: "correction", corrects: "quantity", quantity: -2, correctsId: A },
    });
    expect(
      readCorrection(
        form({ correctsId: A, corrects: "detail", reason: "Wrong delivery note", witness: SIG }),
        t,
        options,
      ),
    ).toMatchObject({ ok: true, body: { corrects: "detail", quantity: 0 } });
    expect(readCorrection(form({ correctsId: A, corrects: "quantity" }), t, options)).toMatchObject(
      {
        ok: false,
        errors: { quantity: expect.any(String), reason: expect.any(String) },
      },
    );
  });

  it("reads a count, which may be 0", () => {
    expect(
      readStockCheck(form({ counted: "0", witness: SIG }), t, {
        waiting: new Set([SIG]),
        loneAllowed: false,
      }),
    ).toMatchObject({ ok: true, body: { counted: 0, reason: null } });
  });
});
