import { describe, expect, it } from "vitest";
import { toMedicinesUpload } from "../sync/medicines-upload";
import {
  type CorrectionInput,
  correctionProblems,
  localCorrectionRow,
  mayCorrectOnPhone,
} from "./correction";

const ORIGINAL = "01890000-0000-7000-8000-0000000000c1";
const ID = "01890000-0000-7000-8000-0000000000c2";
const PERSON = "01890000-0000-7000-8000-0000000000aa";
const ENTRY = "01890000-0000-7000-8000-0000000000bb";
const base: CorrectionInput = {
  id: ID,
  tenantId: "tenant-1",
  personId: PERSON,
  memberId: "member-1",
  original: {
    id: ORIGINAL,
    entryId: ENTRY,
    dueAt: "2026-11-03T08:00:00.000Z",
    givenAt: "2026-11-03T08:05:00.000Z",
    outcome: "given",
    quantity: "2",
    unitCode: "428673006",
    synced: true,
  },
  outcome: "refused",
  reason: { code: "declined", note: null },
  amount: null,
  correctionReason: "Recorded as given by mistake: she declined it",
  controlledDrug: false,
  at: new Date("2026-11-03T09:00:00Z"),
};

describe("hazard HZ-004 a record that reached Thapsus Care is corrected, never changed (slice 70)", () => {
  it.each([
    ["a correction with its reason", {}, []],
    [
      "a record still waiting on this phone",
      { original: { ...base.original, synced: false } },
      ["not_synced"],
    ],
    ["a controlled drug's record", { controlledDrug: true }, ["controlled_drug_on_web"]],
    ["a short reason", { correctionReason: "mistake" }, ["correction_reason_short"]],
    [
      "nothing changed",
      { outcome: "given", reason: null, amount: { quantity: 2, unitCode: "428673006" } },
      ["nothing_changed"],
    ],
  ] as const)("%s", (_case, change, problems) => {
    expect(correctionProblems({ ...base, ...change } as CorrectionInput)).toEqual(problems);
  });

  it("names the record it corrects and is sent to that record's corrections route", () => {
    const row = localCorrectionRow(base);
    expect(row.supersedes_id).toBe(ORIGINAL);
    const request = toMedicinesUpload({
      id: ID,
      op: "PUT",
      table: "medication_administration",
      opData: row,
    });
    expect(request).toMatchObject({
      kind: "request",
      path: `/v1/medicine-administrations/${ORIGINAL}/corrections`,
      body: { id: ID, correctionReason: base.correctionReason, givenAt: base.original.givenAt },
    });
  });

  it("refuses a queued correction whose row names another record", () => {
    const row = { ...localCorrectionRow(base), supersedes_id: ENTRY };
    expect(
      toMedicinesUpload({ id: ID, op: "PUT", table: "medication_administration", opData: row })
        .kind,
    ).toBe("refused");
  });
});

describe("hazard HZ-004 the phone offers Correct only where the API would take it (guides review)", () => {
  it.each([
    [
      "the member's own record",
      { recorded_by: "me" },
      { tenantUserId: "me", permissions: [] },
      true,
    ],
    [
      "someone else's record",
      { recorded_by: "ben" },
      { tenantUserId: "me", permissions: [] },
      false,
    ],
    [
      "someone else's record, for a nurse who may correct anyone's",
      { recorded_by: "ben" },
      { tenantUserId: "me", permissions: ["medicines.record.manage"] },
      true,
    ],
    [
      "a record whose recorder the phone does not know",
      { recorded_by: null },
      { tenantUserId: "me", permissions: [] },
      false,
    ],
  ] as const)("%s", (_case, record, member, may) => {
    expect(mayCorrectOnPhone(record, member)).toBe(may);
  });
});
