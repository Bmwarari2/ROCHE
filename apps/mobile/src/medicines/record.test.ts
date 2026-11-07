import { describe, expect, it } from "vitest";
import { toMedicinesUpload } from "../sync/medicines-upload";
import { type DoseRecordInput, localAdministrationRow, recordProblems } from "./record";

const ID = "01890000-0000-7000-8000-000000000001";
const PERSON = "01890000-0000-7000-8000-0000000000aa";
const ENTRY = "01890000-0000-7000-8000-0000000000bb";
const base: DoseRecordInput = {
  id: ID,
  tenantId: "tenant-1",
  personId: PERSON,
  entryId: ENTRY,
  dueAt: "2026-11-03T08:00:00.000Z",
  outcome: "given",
  reason: null,
  amount: { quantity: 1, unitCode: "428673006" },
  timingReason: null,
  identity: "photo",
  pack: {
    method: "scanned",
    gtin: "05000000000012",
    batch: "B1",
    expiry: "2028-03-31",
    amppId: "1000003",
    override: null,
  },
  memberId: "member-1",
  at: new Date("2026-11-03T08:05:00Z"),
  deviceOffsetMs: null,
  mayGive: true,
  controlledDrug: false,
};

describe("hazard HZ-001 a dose recorded on the phone needs identity and the pack checked (ADR-0081)", () => {
  it.each([
    ["a dose given with both checks", {}, []],
    ["a dose given without identity", { identity: null }, ["identity_not_confirmed"]],
    ["a dose given without a pack check", { pack: null }, ["pack_not_checked"]],
    [
      "a refusal without a reason",
      { outcome: "refused", identity: null, pack: null },
      ["reason_required"],
    ],
    [
      "a refusal for another reason without words",
      { outcome: "refused", reason: { code: "other", note: " " }, identity: null, pack: null },
      ["note_required"],
    ],
    ["a dose given without an amount", { amount: null }, ["amount_required"]],
    ["a controlled drug with no signatures", { controlledDrug: true }, ["cd_signatures_required"]],
    [
      "a controlled drug signed by two people",
      {
        controlledDrug: true,
        cdSignatures: {
          recorder: { keyId: "k1", signature: "s", signedAt: "2026-11-03T08:05:00Z" },
          witness: {
            keyId: "k2",
            signature: "s",
            signedAt: "2026-11-03T08:05:30Z",
            witnessId: "member-2",
          },
        },
      },
      [],
    ],
    [
      "a controlled drug the recorder witnesses",
      {
        controlledDrug: true,
        cdSignatures: {
          recorder: { keyId: "k1", signature: "s", signedAt: "2026-11-03T08:05:00Z" },
          witness: {
            keyId: "k1",
            signature: "s",
            signedAt: "2026-11-03T08:05:00Z",
            witnessId: "member-1",
          },
        },
      },
      ["witness_is_recorder"],
    ],
    ["an entry that may not be given from now", { mayGive: false }, ["may_not_give"]],
    [
      "a dose inside the minimum interval",
      { nextAllowedAt: new Date("2026-11-03T09:00:00Z") },
      ["inside_interval"],
    ],
    [
      "a dose whose last dose may be older than the phone's records",
      { lastDoseNotOnDevice: true },
      ["last_dose_unknown"],
    ],
    ["a dose after a scan of another medicine", { packRefused: true }, ["pack_mismatch"]],
  ] as const)("%s", (_case, overrides, problems) => {
    expect(recordProblems({ ...base, ...overrides } as DoseRecordInput)).toEqual(problems);
  });
});

describe("a dose recorded on the phone is sent to the administrations route (HZ-004, HZ-006)", () => {
  const row = localAdministrationRow(base);

  it("is written at once, waiting to sync, with the checks in the request", () => {
    expect(row).toMatchObject({
      id: ID,
      person_id: PERSON,
      medication_id: ENTRY,
      outcome: "given",
    });
    const queued = JSON.parse(row.request as string);
    expect(queued.body).toMatchObject({
      id: ID,
      deviceRecordedAt: "2026-11-03T08:05:00.000Z",
      entryId: ENTRY,
      pointOfCare: { identity: "photo", pack: { method: "scanned", gtin: "05000000000012" } },
    });
  });

  it("maps the queued row to POST /v1/people/{id}/medicine-administrations, keyed by its id", () => {
    const request = toMedicinesUpload({
      id: ID,
      op: "PUT",
      table: "medication_administration",
      opData: row,
    });
    expect(request).toMatchObject({
      kind: "request",
      path: `/v1/people/${PERSON}/medicine-administrations`,
      recordId: ID,
    });
  });

  it.each([
    ["a change to a sent record", { op: "PATCH" }],
    ["a row whose request names another person", { opData: { ...row, person_id: ENTRY } }],
    ["a row whose request is not readable", { opData: { ...row, request: "{" } }],
  ])("refuses %s, to needs attention", (_case, change) => {
    const request = toMedicinesUpload({
      id: ID,
      op: "PUT",
      table: "medication_administration",
      opData: row,
      ...change,
    } as Parameters<typeof toMedicinesUpload>[0]);
    expect(request.kind).toBe("refused");
  });
});
