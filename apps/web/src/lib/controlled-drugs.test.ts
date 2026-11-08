import { describe, expect, it } from "vitest";
import {
  CD_RECORDING_FLAG,
  type CdEntry,
  cdRecordingOn,
  cdShown,
  countOverdue,
  doseWitnessFrom,
  doseWitnessHref,
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

  it("shows a count's result as an icon and words, balanced or not", () => {
    expect(stockCheckChip({ difference: 0 }, "tablet", t)).toMatchObject({
      status: "done",
      label: "Balanced",
    });
    expect(stockCheckChip({ difference: -2 }, "tablet", t)).toMatchObject({
      status: "overdue",
      label: "Short by 2 tablet",
    });
    expect(stockCheckChip({ difference: 0.5 }, "ml", t).label).toBe("Over by 0.5 ml");
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

  it("hazard HZ-116 lets a witness sign only for someone else, offered by the API", () => {
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

  it("hazard HZ-116 records with a waiting signature, or a reason only where allowed and never for a destruction", () => {
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

describe("hazard HZ-115 hazard HZ-008 the paper register is the record until Thapsus Care's is released at the home (H-1517)", () => {
  it.each([
    ["the flag on at the location", { [CD_RECORDING_FLAG]: true }, true],
    ["the flag off", { [CD_RECORDING_FLAG]: false }, false],
    ["the flag missing from the answer", { "module.emar": true }, false],
    ["no answer from the API", null, false],
    ["nothing read", undefined, false],
  ] as const)("%s: turned on is %s", (_case, flags, on) => {
    expect(cdRecordingOn(flags)).toBe(on);
  });

  it("says in words that the paper register is the record, and the round no longer sends staff to Thapsus Care's", () => {
    expect(t("cd.notTurnedOn.title")).toMatch(/not turned on/);
    expect(t("cd.notTurnedOn.body")).toMatch(/paper controlled drugs register is the record/);
    expect(t("medicines.round.cdNotice")).toMatch(/paper controlled drugs register/);
    expect(t("medicines.round.cdNotice")).not.toMatch(/in the controlled drugs register/);
  });
});

describe("a witness's link for a dose record's correction (HZ-004)", () => {
  const dose = {
    administrationId: SIG,
    movement: "correction" as const,
    quantity: -0.5,
    recorderId: B,
  };
  it("hazard HZ-115 carries exactly what the witness signs for, and reads back", () => {
    const href = doseWitnessHref(A, B, dose);
    const query = Object.fromEntries(new URL(href, "https://x.invalid").searchParams);
    expect(doseWitnessFrom(query)).toEqual({ ...dose, quantity: "-0.5" });
  });

  it.each([
    ["no record", { movement: "correction", quantity: "1", recorder: B }],
    ["a register movement", { dose: SIG, movement: "receipt", quantity: "1", recorder: B }],
    ["no quantity", { dose: SIG, movement: "administration", quantity: "x", recorder: B }],
  ])("ignores a link with %s", (_name, query) => {
    expect(doseWitnessFrom(query)).toBeNull();
  });

  it("hazard HZ-115 signs for the record named, and only a dose's movements", () => {
    const recorders = new Set([B]);
    const sign = { movement: "administration", quantity: "1", recorderId: B };
    expect(readWitness(form({ ...sign, administrationId: SIG }), t, recorders)).toMatchObject({
      ok: true,
      body: { movement: "administration", administrationId: SIG },
    });
    expect(readWitness(form(sign), t, recorders).ok).toBe(false);
    expect(
      readWitness(form({ ...sign, movement: "receipt", administrationId: SIG }), t, recorders).ok,
    ).toBe(false);
  });
});
