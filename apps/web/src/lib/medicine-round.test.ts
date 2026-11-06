import { OUTCOME_REASONS } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  type CovertRecord,
  covertChip,
  covertFor,
  doseChip,
  type Entry,
  OUTCOME_REASON_CODES,
  OUTCOMES,
  offeredAmount,
  prescribedDose,
  readAdministration,
  recordDoseHref,
  roundPeople,
} from "./medicine-round";

/**
 * The web medicines round (slice 53; medicines.md section 16): state as an icon and a word, the dose
 * offered as prescribed, the covert record beside the medicine, and the record-a-dose form read into
 * the request with every mistake said at its field. Hazard ids in the names (HZ-003, HZ-007, HZ-117).
 */

const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};
const context = {
  id: "0194d000-0000-7000-8000-00000000a001",
  entryId: "0194d000-0000-7000-8000-00000000a002",
  dueAt: "2026-11-06T08:00:00.000Z",
  unitCode: "428673006",
};
const TABLET = { code: "428673006", name: "tablet" };
const regular = {
  directions: {
    kind: "regular",
    schedule: {
      pattern: { kind: "every_day" },
      times: [
        { time: "08:00", dose: { kind: "amount", quantity: 2, unit: TABLET } },
        { time: "20:00", dose: { kind: "range", from: 1, to: 2, unit: TABLET } },
      ],
    },
  },
} as unknown as Pick<Entry, "directions">;
const prn = {
  directions: { kind: "when_required", dose: { kind: "amount", quantity: 15, unit: TABLET } },
} as unknown as Pick<Entry, "directions">;

describe("hazard HZ-003 a dose's state is an icon and a word, never colour alone", () => {
  it.each([
    ["late", "overdue"],
    ["due", "due"],
    ["not_yet_due", "notApplicable"],
    ["recorded", "done"],
  ] as const)("%s", (state, status) => {
    const chip = doseChip(state, "Words from the API");
    expect(chip).toMatchObject({ status, label: "Words from the API" });
    expect(chip.icon).toBeTruthy();
  });
});

describe("the dose offered is the one prescribed for that time", () => {
  it.each([
    ["the 08:00 amount", regular, "08:00", "2"],
    ["a range is typed, never guessed", regular, "20:00", ""],
    ["a time the entry does not have", regular, "12:00", ""],
    ["a when-required dose", prn, null, "15"],
    ["a scheduled entry with no time", regular, null, ""],
  ] as const)("%s", (_, entry, time, offered) => {
    expect(offeredAmount(prescribedDose(entry, time))).toBe(offered);
  });

  it("keeps the unit from the prescription", () => {
    expect(prescribedDose(regular, "20:00")?.unit).toEqual(TABLET);
  });
});

describe("hazard HZ-007 the covert record shown beside the medicine (H-1354)", () => {
  const record = (status: CovertRecord["status"], medicineId = "m1") =>
    ({ medicineId, status, statusWords: `Words ${status}` }) as CovertRecord;

  it("finds the record for the entry's medicine that is not ended", () => {
    const records = [record("ended"), record("current"), record("current", "m2")];
    expect(covertFor({ medicineId: "m1" }, records)?.status).toBe("current");
    expect(covertFor({ medicineId: "m3" }, records)).toBeNull();
    expect(covertFor({ medicineId: "m1" }, [record("ended")])).toBeNull();
  });

  it.each([
    ["current", "done"],
    ["review_overdue", "overdue"],
    ["basis_changed", "overdue"],
    ["not_started", "notApplicable"],
  ] as const)("says %s in words with an icon", (status, chip) => {
    expect(covertChip(record(status))).toMatchObject({ status: chip, label: `Words ${status}` });
  });
});

describe("the outcomes and reasons match the domain's", () => {
  it("offers every outcome with the domain's coded reasons", () => {
    expect([...OUTCOMES].sort()).toEqual(Object.keys(OUTCOME_REASONS).sort());
    for (const outcome of OUTCOMES) {
      expect(OUTCOME_REASON_CODES[outcome]).toEqual(OUTCOME_REASONS[outcome]);
    }
  });
});

describe("hazard HZ-003 reading the record-a-dose form", () => {
  it("reads a dose given, with the amount in the prescribed unit and the server's time", () => {
    const read = readAdministration(form({ outcome: "given", quantity: "2" }), t, context);
    expect(read).toEqual({
      ok: true,
      body: expect.objectContaining({
        id: context.id,
        entryId: context.entryId,
        dueAt: context.dueAt,
        outcome: "given",
        reason: null,
        amount: { quantity: 2, unitCode: TABLET.code },
        covert: false,
        givenAt: null,
      }),
    });
  });

  it("reads a refusal with its reason and no amount", () => {
    const read = readAdministration(
      form({ outcome: "refused", reasonCode: "declined", quantity: "2" }),
      t,
      context,
    );
    expect(read.ok && read.body).toMatchObject({
      outcome: "refused",
      reason: { code: "declined", note: null },
      amount: null,
    });
  });

  it("reads covert only on a dose given", () => {
    const read = readAdministration(
      form({ outcome: "given", quantity: "1", covert: "yes" }),
      t,
      context,
    );
    expect(read.ok && read.body.covert).toBe(true);
  });

  it.each([
    ["no outcome", {}, "outcome"],
    ["an outcome that does not exist", { outcome: "lost" }, "outcome"],
    ["a refusal with no reason", { outcome: "refused" }, "reasonCode"],
    ["a reason of another outcome", { outcome: "omitted", reasonCode: "declined" }, "reasonCode"],
    ["other with no words", { outcome: "withheld", reasonCode: "other" }, "reasonNote"],
    ["given with no amount", { outcome: "given" }, "quantity"],
    ["a leading zero", { outcome: "given", quantity: "01" }, "quantity"],
    ["zero", { outcome: "given", quantity: "0" }, "quantity"],
    ["four decimal places", { outcome: "given", quantity: "1.2345" }, "quantity"],
    ["words for an amount", { outcome: "given", quantity: "two" }, "quantity"],
    [
      "covert on a refusal",
      { outcome: "refused", reasonCode: "declined", covert: "yes" },
      "covert",
    ],
  ])("refuses %s at its field", (_, values, field) => {
    const read = readAdministration(form(values), t, context);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors)).toContain(field);
  });

  it("refuses an amount when the prescribed unit is not known, never sending a guess", () => {
    const read = readAdministration(form({ outcome: "given", quantity: "1" }), t, {
      ...context,
      unitCode: null,
    });
    expect(read.ok).toBe(false);
  });

  it("sends a when-required dose with no due time", () => {
    const read = readAdministration(form({ outcome: "given", quantity: "15" }), t, {
      ...context,
      dueAt: null,
    });
    expect(read.ok && read.body.dueAt).toBeNull();
  });
});

describe("addresses and people", () => {
  it("links a scheduled dose by its due time and a when-required dose without", () => {
    expect(recordDoseHref("p1", "e1", "2026-11-06T08:00:00.000Z")).toBe(
      "/people/p1/medicines/round/record?entry=e1&due=2026-11-06T08%3A00%3A00.000Z",
    );
    expect(recordDoseHref("p1", "e1", null)).toBe("/people/p1/medicines/round/record?entry=e1");
  });

  it("keeps the API's order and names each person it can", () => {
    const rows = roundPeople([{ personId: "b" }, { personId: "a" }], [{ id: "a" }]);
    expect(rows.map((r) => [r.entry.personId, r.person?.id ?? null])).toEqual([
      ["b", null],
      ["a", "a"],
    ]);
  });
});
