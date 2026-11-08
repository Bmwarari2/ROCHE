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
  mayRecordCd: true,
  controlledDrug: false,
};

describe("hazards HZ-001 and HZ-116 a dose recorded on the phone needs identity, the pack checked and, for a controlled drug, a recorder who may record it", () => {
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
    [
      "hazard HZ-004 a when-required dose of 2 when 1 is left of its 24-hour maximum",
      { amount: { quantity: 2, unitCode: "428673006" }, prnRemaining: 1 },
      ["over_24h_maximum"],
    ],
    [
      "hazard HZ-004 a when-required dose of exactly what is left of its 24-hour maximum",
      { amount: { quantity: 1, unitCode: "428673006" }, prnRemaining: 1 },
      [],
    ],
    [
      "a when-required dose with no 24-hour maximum",
      { amount: { quantity: 4, unitCode: "428673006" }, prnRemaining: null },
      [],
    ],
    [
      "hazard HZ-004 a refusal recorded when nothing is left of the 24-hour maximum",
      {
        outcome: "refused",
        reason: { code: "other", note: "Said no thank you" },
        identity: null,
        pack: null,
        prnRemaining: 0,
      },
      [],
    ],
    ["a controlled drug with no signatures", { controlledDrug: true }, ["cd_signatures_required"]],
    [
      "a controlled drug from someone who may not record controlled drugs",
      { controlledDrug: true, mayRecordCd: false },
      ["cd_not_permitted"],
    ],
    [
      "a controlled drug refused by someone who may not record controlled drugs",
      {
        controlledDrug: true,
        mayRecordCd: false,
        outcome: "refused",
        reason: { code: "other", note: "Said no thank you" },
        identity: null,
        pack: null,
      },
      [],
    ],
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
          noWitnessReason: null,
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
          noWitnessReason: null,
        },
      },
      ["witness_is_recorder"],
    ],
    [
      "a controlled drug with why there was no witness",
      {
        controlledDrug: true,
        cdSignatures: {
          recorder: { keyId: "k1", signature: "s", signedAt: "2026-11-03T08:05:00Z" },
          witness: null,
          noWitnessReason: "Working alone at the person's home",
        },
        witnessPolicy: "where_available",
      },
      [],
    ],
    [
      "a controlled drug with no witness at a home that requires one",
      {
        controlledDrug: true,
        cdSignatures: {
          recorder: { keyId: "k1", signature: "s", signedAt: "2026-11-03T08:05:00Z" },
          witness: null,
          noWitnessReason: "No one else on shift",
        },
        witnessPolicy: "required",
      },
      ["cd_witness_required"],
    ],
    [
      "a controlled drug with no witness where the home's policy is not known",
      {
        controlledDrug: true,
        cdSignatures: {
          recorder: { keyId: "k1", signature: "s", signedAt: "2026-11-03T08:05:00Z" },
          witness: null,
          noWitnessReason: "No one else on shift",
        },
      },
      ["cd_witness_required"],
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

describe("hazard HZ-115 a dose refused on upload is copied to the server, never only on one phone (slice 70)", () => {
  it("builds the copy from the request the phone would have sent", async () => {
    const { toRefusedCopy } = await import("../sync/refused-copies");
    const row = localAdministrationRow(base);
    const copy = toRefusedCopy(
      {
        id: ID,
        tenant_id: "tenant-1",
        person_id: PERSON,
        record_table: "medication_administration",
        http_status: 422,
        code: "administration_witness_key_replaced",
        message: "A signature was made with a PIN that had been replaced on this phone.",
        payload: JSON.stringify(row),
        rejected_at: "2026-11-03T09:00:00Z",
      },
      new Date("2026-11-03T09:01:00Z"),
    );
    expect(copy).toMatchObject({
      kind: "copy",
      body: { table: "medication_administration", payload: { kind: "record", body: { id: ID } } },
    });
  });
});
