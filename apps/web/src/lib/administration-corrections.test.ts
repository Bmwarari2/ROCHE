import { describe, expect, it } from "vitest";
import {
  type Administration,
  type Conflict,
  conflictHref,
  correctHref,
  correctionSince,
  decisionsFor,
  readCorrection,
  readDecision,
  recordsAgree,
  registerMove,
  sameRecorder,
} from "./administration-corrections";
import { t } from "./i18n";

/** Doses recorded twice and corrections on the web (HZ-004; medicines.md 15.4 and 14.4). */

const A = "0194d000-0000-7000-8000-0000000000a1";
const B = "0194d000-0000-7000-8000-0000000000a2";
const SIG = "0194d000-0000-7000-8000-0000000000c1";
const NURSE = "0194d000-0000-7000-8000-000000000303";
const CARER = "0194d000-0000-7000-8000-000000000304";
const form = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

const record = (over: Partial<Administration> = {}): Administration =>
  ({
    id: A,
    personId: B,
    entryId: B,
    dueAt: "2026-11-08T08:00:00.000Z",
    outcome: "given",
    outcomeInWords: "Given",
    reason: null,
    amount: { quantity: 1, unitCode: "428673006" },
    prescribed: null,
    dosingRecordId: null,
    givenAt: "2026-11-08T08:05:00.000Z",
    administeredBy: CARER,
    recorded: { id: CARER, at: "2026-11-08T08:05:00.000Z" },
    flags: [],
    covert: false,
    flagsInWords: [],
    givenBeforeRecordedReason: null,
    supersedesId: null,
    correctionReason: null,
    supersededById: null,
    witness: null,
    inCdRegister: true,
    ...over,
  }) as Administration;

const conflict = (over: {
  current?: Partial<Administration>;
  uploaded?: string;
  quantity?: number | null;
  corrected?: boolean;
}): Conflict =>
  ({
    standing: record(),
    current: over.corrected
      ? record({
          id: SIG,
          recorded: { id: NURSE, at: "2026-11-08T10:00:00.000Z" },
          ...over.current,
        })
      : record(over.current),
    uploaded: {
      outcome: over.uploaded ?? "given",
      amount:
        over.quantity === null ? null : { quantity: over.quantity ?? 1, unitCode: "428673006" },
    },
    joined: [],
    uploadedBy: NURSE,
    receivedAt: "2026-11-08T09:00:00.000Z",
  }) as unknown as Conflict;

describe("the decisions a conflict allows (HZ-004)", () => {
  it.each([
    ["both given", {}, ["first_stands", "both_given"]],
    ["first not given, second given", { current: { outcome: "omitted", amount: null } }, []],
    ["first given, second refused", { uploaded: "refused", quantity: null }, ["first_stands"]],
    [
      "corrected after the upload",
      { corrected: true, current: { outcome: "omitted" as const, amount: null } },
      ["corrected"],
    ],
  ] as const)("hazard HZ-004 %s", (_name, over, expected) => {
    expect(decisionsFor(conflict(over))).toEqual(expected);
  });

  it("hazard HZ-004 names no correction made before the second record arrived", () => {
    const c = conflict({
      corrected: true,
      current: { recorded: { id: NURSE, at: "2026-11-08T08:30:00.000Z" } },
    });
    expect(correctionSince(c)).toBeNull();
    expect(decisionsFor(c)).not.toContain("corrected");
  });

  it("says whether the records agree, and who recorded them", () => {
    expect(recordsAgree(conflict({}))).toBe(true);
    expect(recordsAgree(conflict({ quantity: 2 }))).toBe(false);
    expect(sameRecorder(conflict({}))).toBe(false);
  });

  it("hazard HZ-004 who recorded is read from the first record, not a later correction", () => {
    // The carer recorded the first; the nurse sent the second and then corrected the first.
    const c = { ...conflict({ corrected: true }), uploadedBy: NURSE };
    expect(c.current.recorded.id).toBe(NURSE);
    expect(sameRecorder(c)).toBe(false);
    expect(sameRecorder({ ...c, uploadedBy: CARER })).toBe(true);
  });
});

describe("what a correction does to the controlled drugs register (14.4)", () => {
  const at = "2026-11-08T08:05:00.000Z";
  const later = "2026-11-08T08:35:00.000Z";
  it.each([
    ["nothing changes", record(), { outcome: "given", quantity: 1, givenAt: at }, null],
    [
      "a dose not given is now given",
      record({ outcome: "omitted", amount: null }),
      { outcome: "given", quantity: 1, givenAt: at },
      { movement: "administration", quantity: 1 },
    ],
    [
      "a given dose not in the register",
      record({ inCdRegister: false }),
      { outcome: "given", quantity: 2, givenAt: at },
      { movement: "administration", quantity: 2 },
    ],
    [
      "not in the register and now not given",
      record({ inCdRegister: false }),
      { outcome: "refused", quantity: null, givenAt: at },
      null,
    ],
    [
      "less was given",
      record({ amount: { quantity: 2, unitCode: "x" } }),
      { outcome: "given", quantity: 1, givenAt: at },
      { movement: "correction", quantity: 1 },
    ],
    [
      "the dose was not given after all",
      record(),
      { outcome: "omitted", quantity: null, givenAt: at },
      { movement: "correction", quantity: 1 },
    ],
    [
      "more was given",
      record(),
      { outcome: "given", quantity: 1.5, givenAt: at },
      { movement: "correction", quantity: -0.5 },
    ],
    [
      "only the time moved",
      record(),
      { outcome: "given", quantity: 1, givenAt: later },
      { movement: "correction", quantity: 0 },
    ],
  ] as const)("hazard HZ-115 %s", (_name, original, corrected, expected) => {
    expect(registerMove(original, corrected)).toEqual(expected);
  });
});

describe("reading the correction form", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  const base = {
    outcome: "given",
    quantity: "1",
    correctionReason: "The time was wrong",
    "givenAt-day": "08",
    "givenAt-month": "11",
    "givenAt-year": "2026",
    "givenAt-hour": "08",
    "givenAt-minute": "35",
  };
  const context = (over: Partial<Parameters<typeof readCorrection>[2]> = {}) => ({
    id: SIG,
    original: record(),
    unitCode: "428673006",
    controlledDrug: false,
    waiting: new Set<string>(),
    loneAllowed: false,
    now,
    ...over,
  });

  it("reads a correction of a medicine that is not a controlled drug", () => {
    const read = readCorrection(form(base), t, context());
    expect(read).toMatchObject({
      ok: true,
      body: {
        id: SIG,
        outcome: "given",
        amount: { quantity: 1, unitCode: "428673006" },
        correctionReason: "The time was wrong",
        givenAt: "2026-11-08T08:35:00.000Z",
        controlledDrug: null,
      },
    });
  });

  it("asks for why, and a time that has passed", () => {
    const read = readCorrection(
      form({ ...base, correctionReason: "", "givenAt-hour": "13" }),
      t,
      context(),
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors).sort()).toEqual(["correctionReason", "givenAt"]);
  });

  it("hazard HZ-115 a controlled drug's correction names a signature waiting for it", () => {
    const cd = context({ controlledDrug: true, waiting: new Set([B]) });
    expect(readCorrection(form(base), t, cd).ok).toBe(false);
    expect(readCorrection(form({ ...base, witness: A }), t, cd).ok).toBe(false);
    expect(readCorrection(form({ ...base, witness: B }), t, cd)).toMatchObject({
      ok: true,
      body: { controlledDrug: { witnessAssertionId: B } },
    });
  });

  it("hazard HZ-115 no witness only where the policy allows it, with why", () => {
    const none = { ...base, witness: "none", noWitnessReason: "Alone on nights" };
    expect(readCorrection(form(none), t, context({ controlledDrug: true })).ok).toBe(false);
    expect(
      readCorrection(form(none), t, context({ controlledDrug: true, loneAllowed: true })),
    ).toMatchObject({ ok: true, body: { controlledDrug: { noWitnessReason: "Alone on nights" } } });
  });

  it.each([
    // The clocks went back at 02:00 BST on 25/10/2026: 01:30 happened twice, so ask which.
    [
      "the repeated hour, unchosen",
      { "givenAt-day": "25", "givenAt-month": "10", "givenAt-hour": "01", "givenAt-minute": "30" },
      null,
    ],
    [
      "the repeated hour, the first",
      {
        "givenAt-day": "25",
        "givenAt-month": "10",
        "givenAt-hour": "01",
        "givenAt-minute": "30",
        "givenAt-fold": "first",
      },
      "2026-10-25T00:30:00.000Z",
    ],
    [
      "the repeated hour, the second",
      {
        "givenAt-day": "25",
        "givenAt-month": "10",
        "givenAt-hour": "01",
        "givenAt-minute": "30",
        "givenAt-fold": "second",
      },
      "2026-10-25T01:30:00.000Z",
    ],
    // The clocks went forward at 01:00 GMT on 29/03/2026: 01:30 never happened.
    [
      "the skipped hour",
      { "givenAt-day": "29", "givenAt-month": "03", "givenAt-hour": "01", "givenAt-minute": "30" },
      null,
    ],
  ] as const)(
    "hazard HZ-010 the time corrected across a clock change: %s",
    (_name, parts, instant) => {
      const read = readCorrection(form({ ...base, ...parts }), t, context());
      if (instant === null) {
        expect(read.ok).toBe(false);
        if (!read.ok) expect(Object.keys(read.errors)).toEqual(["givenAt"]);
      } else {
        expect(read).toMatchObject({ ok: true, body: { givenAt: instant } });
      }
    },
  );

  it("asks for no witness when the register does not move", () => {
    const same = { ...base, "givenAt-minute": "05" };
    expect(readCorrection(form(same), t, context({ controlledDrug: true }))).toMatchObject({
      ok: true,
      body: { controlledDrug: null },
    });
  });
});

describe("reading the decision", () => {
  it("needs a decision offered and what was found out", () => {
    expect(readDecision(form({ outcome: "both_given" }), t, ["first_stands"], null).ok).toBe(false);
    expect(
      readDecision(form({ outcome: "corrected", note: "Checked" }), t, ["corrected"], SIG),
    ).toEqual({ ok: true, body: { outcome: "corrected", correctionId: SIG, note: "Checked" } });
    expect(
      readDecision(form({ outcome: "first_stands", note: "Sent twice" }), t, ["first_stands"], SIG),
    ).toEqual({
      ok: true,
      body: { outcome: "first_stands", correctionId: null, note: "Sent twice" },
    });
  });

  it("builds the addresses", () => {
    expect(conflictHref(A, B)).toBe(`/medicines-round/${A}/conflicts/${B}`);
    expect(correctHref(B, A, SIG)).toBe(
      `/people/${B}/medicines/administrations/${A}/correct?conflict=${SIG}`,
    );
  });
});
