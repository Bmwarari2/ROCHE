import { beforeAll, describe, expect, it } from "vitest";
import { medsRecentDays } from "../src/client/window";
import { readSyncConfig, type SyncTokenClaims } from "../src/streams/index";
import { compile, ids, type SourceRows, syncFor } from "./support/simulator";

/**
 * Medicines on the phone (medicines.md section 13.8; Phase 2 slice 68; ADR-0130). Logical
 * replication bypasses row-level security, so these tests alone prove that a phone receives only
 * the medicines of the people in the member's `medicines.emar.administer` scope (assigned people, or
 * live people at the token's locations), in the token's tenant; every MAR entry version not
 * withdrawn or removed (a replaced one too, so a change from tomorrow never takes today's doses
 * off the phone), with the person's schedules, dosing and covert records (of any version; the
 * phone shows only those of a version it holds; H-1425), in buckets per person, never per version;
 * administrations recorded on the token's days only; and the
 * member's own medicines competence, never a colleague's; and that nothing the device sends widens
 * it (hazards HZ-011, HZ-002). Invented ids only.
 */

const A = "tenant-a";
const B = "tenant-b";
const NORTH = "loc-a-north";
const SOUTH = "loc-a-south";
const NOW = new Date("2026-11-06T10:00:00Z");
const DAYS = medsRecentDays(NOW);

const person = (id: string, tenant: string, location: string, status = "active") => ({
  id,
  tenant_id: tenant,
  location_id: location,
  status,
});

const medication = (id: string, tenant: string, personId: string, state = "checked") => ({
  id,
  tenant_id: tenant,
  person_id: personId,
  medicine_id: `${id}-medicine`,
  version: 1,
  replaces_id: null,
  state,
  vmp_id: "vmp-1",
  amp_id: null,
  product_name: "Paracetamol 500mg tablets",
  route_code: "26643006",
  route_name: "Oral",
  directions: "Two tablets four times a day",
  pattern_kind: "daily",
  interval_days: null,
  weekdays: null,
  interval_weeks: null,
  anchor_on: null,
  day_of_month: null,
  prn_dose: null,
  tags: "[]",
  minimum_interval_minutes: 240,
  indication: null,
  special_instructions: null,
  starts_at: "2026-10-01 08:00:00+00",
  stops_at: null,
  stop_effective_at: state === "stopped" ? "2026-11-07 08:00:00+00" : null,
  cd_schedule: null,
  check_outcome: "agreed",
  updated_at: "2026-10-01 09:00:00+00",
  deleted_at: null,
});

const administration = (id: string, tenant: string, personId: string, recordedAt: string) => ({
  id,
  tenant_id: tenant,
  person_id: personId,
  medication_id: "m-ada",
  due_at: recordedAt,
  outcome: "given",
  reason_code: null,
  quantity: "2",
  unit_code: "tablet",
  given_at: recordedAt,
  administered_by: "carer",
  recorded_at: recordedAt,
  supersedes_id: null,
  covert: 0,
  flags: "[]",
});

const source: SourceRows = {
  person: [
    person("ada", A, NORTH),
    person("bea", A, NORTH),
    person("cal", A, NORTH, "discharged"),
    person("dee", A, SOUTH),
    person("eve", B, NORTH),
  ],
  person_assignment: [
    { id: "pa1", tenant_id: A, person_id: "ada", tenant_user_id: "carer", deleted_at: null },
    {
      id: "pa2",
      tenant_id: A,
      person_id: "bea",
      tenant_user_id: "carer",
      deleted_at: "2026-11-01",
    },
    { id: "pa3", tenant_id: B, person_id: "eve", tenant_user_id: "carer", deleted_at: null },
  ],
  medication: [
    medication("m-ada", A, "ada"),
    medication("m-ada-unchecked", A, "ada", "not_yet_checked"),
    medication("m-ada-difference", A, "ada", "difference_found"),
    medication("m-ada-stopped", A, "ada", "stopped"),
    medication("m-ada-replaced", A, "ada", "replaced"),
    medication("m-ada-withdrawn", A, "ada", "withdrawn"),
    { ...medication("m-ada-removed", A, "ada"), deleted_at: "2026-11-02 09:00:00+00" },
    medication("m-bea", A, "bea"),
    medication("m-cal", A, "cal"),
    medication("m-dee", A, "dee"),
    medication("m-eve", B, "eve"),
  ],
  medication_schedule: [
    {
      id: "s-ada-replaced",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada-replaced",
      position: 1,
      time: "08:00",
      dose_kind: "fixed",
      quantity: "2",
      from_quantity: null,
      to_quantity: null,
      unit_code: "tablet",
      unit_name: "tablet",
    },
    {
      id: "s-ada-withdrawn",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada-withdrawn",
      position: 1,
      time: "08:00",
      dose_kind: "fixed",
      quantity: "2",
      from_quantity: null,
      to_quantity: null,
      unit_code: "tablet",
      unit_name: "tablet",
    },
    {
      id: "s-ada-removed",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada-removed",
      position: 1,
      time: "08:00",
      dose_kind: "fixed",
      quantity: "2",
      from_quantity: null,
      to_quantity: null,
      unit_code: "tablet",
      unit_name: "tablet",
    },
    {
      id: "s-ada",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada",
      position: 1,
      time: "08:00",
      dose_kind: "fixed",
      quantity: "2",
      from_quantity: null,
      to_quantity: null,
      unit_code: "tablet",
      unit_name: "tablet",
    },
    {
      id: "s-bea",
      tenant_id: A,
      person_id: "bea",
      medication_id: "m-bea",
      position: 1,
      time: "08:00",
      dose_kind: "fixed",
      quantity: "1",
      from_quantity: null,
      to_quantity: null,
      unit_code: "tablet",
      unit_name: "tablet",
    },
  ],
  medication_dosing_record: [
    {
      id: "d-ada-replaced",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada-replaced",
      doses: "[]",
      check_outcome: "agreed",
      check_at: "2026-11-05 09:00:00+00",
      recorded_at: "2026-11-05 08:00:00+00",
    },
    {
      id: "d-ada-withdrawn",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada-withdrawn",
      doses: "[]",
      check_outcome: "agreed",
      check_at: "2026-11-05 09:00:00+00",
      recorded_at: "2026-11-05 08:00:00+00",
    },
    {
      id: "d-ada",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada",
      doses: "[]",
      check_outcome: "agreed",
      check_at: "2026-11-05 09:00:00+00",
      recorded_at: "2026-11-05 08:00:00+00",
    },
  ],
  covert_medication_record: [
    {
      id: "c-ada-replaced",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada-replaced",
      medicine_id: "m-ada-medicine",
      method: "x",
      pharmacist_advice: null,
      starts_on: "2026-10-01",
      review_on: "2027-01-01",
      reviewed_on: null,
      ended_on: null,
      version: 1,
      deleted_at: null,
    },
    {
      id: "c-ada-withdrawn",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada-withdrawn",
      medicine_id: "m-ada-medicine",
      method: "x",
      pharmacist_advice: null,
      starts_on: "2026-10-01",
      review_on: "2027-01-01",
      reviewed_on: null,
      ended_on: null,
      version: 1,
      deleted_at: null,
    },
    {
      id: "c-ada",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada",
      medicine_id: "m-ada-medicine",
      method: "Crushed in yoghurt",
      pharmacist_advice: "Can be crushed",
      starts_on: "2026-10-01",
      review_on: "2027-01-01",
      reviewed_on: null,
      ended_on: null,
      version: 1,
      deleted_at: null,
    },
    {
      id: "c-ada-removed",
      tenant_id: A,
      person_id: "ada",
      medication_id: "m-ada",
      medicine_id: "m-ada-medicine",
      method: "x",
      pharmacist_advice: null,
      starts_on: "2026-10-01",
      review_on: "2027-01-01",
      reviewed_on: null,
      ended_on: null,
      version: 1,
      deleted_at: "2026-11-01 09:00:00+00",
    },
  ],
  medication_administration: [
    administration("a-ada-today", A, "ada", "2026-11-06 08:00:00+00"),
    administration("a-ada-two-days", A, "ada", "2026-11-04 08:00:00+00"),
    administration("a-ada-month", A, "ada", "2026-10-03 08:00:00+00"),
    administration("a-ada-old", A, "ada", "2026-10-02 23:59:00+00"),
    administration("a-bea-today", A, "bea", "2026-11-06 08:00:00+00"),
    administration("a-eve-today", B, "eve", "2026-11-06 08:00:00+00"),
  ],
  competence_sign_off: [
    {
      id: "cs-carer",
      tenant_id: A,
      worker_id: "carer",
      competence: "medicines_administration",
      observed_on: "2026-01-01",
      valid_until: "2027-01-01",
    },
    {
      id: "cs-carer-hoist",
      tenant_id: A,
      worker_id: "carer",
      competence: "moving_and_handling_hoist",
      observed_on: "2026-01-01",
      valid_until: "2027-01-01",
    },
    {
      id: "cs-colleague",
      tenant_id: A,
      worker_id: "colleague",
      competence: "medicines_administration",
      observed_on: "2026-01-01",
      valid_until: "2027-01-01",
    },
    {
      id: "cs-carer-b",
      tenant_id: B,
      worker_id: "carer",
      competence: "medicines_administration",
      observed_on: "2026-01-01",
      valid_until: "2027-01-01",
    },
  ],
  competence_withdrawal: [
    { id: "cw-carer", tenant_id: A, sign_off_id: "cs-carer" },
    { id: "cw-carer-hoist", tenant_id: A, sign_off_id: "cs-carer-hoist" },
    { id: "cw-colleague", tenant_id: A, sign_off_id: "cs-colleague" },
  ],
};

const claims = (overrides: Partial<SyncTokenClaims> = {}): Partial<SyncTokenClaims> => ({
  sub: "carer",
  tenant_id: A,
  location_ids: [NORTH],
  people_location_ids: [],
  care_location_ids: [],
  entries_location_ids: [],
  handover_location_ids: [],
  people_assigned: true,
  care_assigned: true,
  entries_assigned: false,
  handover_assigned: false,
  offline_days: [],
  meds_location_ids: [],
  meds_assigned: true,
  meds_recent_days: DAYS,
  ...overrides,
});

let hydrated: ReturnType<typeof compile>["hydrated"];

beforeAll(() => {
  const compiled = compile(readSyncConfig());
  expect(compiled.errors).toEqual([]);
  hydrated = compiled.hydrated;
});

describe("hazard HZ-011 only the medicines of the people in the member's scope reach the phone", () => {
  it("gives a care worker their assigned people's MAR entry versions with their schedules, never withdrawn or removed ones", async () => {
    const device = await syncFor(hydrated, source, claims());
    expect(ids(device, "medication")).toEqual([
      "m-ada",
      "m-ada-difference",
      "m-ada-replaced",
      "m-ada-stopped",
      "m-ada-unchecked",
    ]);
    // A person's schedules, dosing and covert records come whatever version they belong to
    // (H-1425); a removed covert record never does.
    expect(ids(device, "medication_schedule")).toEqual([
      "s-ada",
      "s-ada-removed",
      "s-ada-replaced",
      "s-ada-withdrawn",
    ]);
    expect(ids(device, "medication_dosing_record")).toEqual([
      "d-ada",
      "d-ada-replaced",
      "d-ada-withdrawn",
    ]);
    expect(ids(device, "covert_medication_record")).toEqual([
      "c-ada",
      "c-ada-replaced",
      "c-ada-withdrawn",
    ]);
  });

  it("gives administrations recorded on the token's days only (35 UTC days, for monthly medicines)", async () => {
    const device = await syncFor(hydrated, source, claims());
    expect(ids(device, "medication_administration")).toEqual([
      "a-ada-month",
      "a-ada-today",
      "a-ada-two-days",
    ]);
    const none = await syncFor(hydrated, source, claims({ meds_recent_days: [] }));
    expect(ids(none, "medication_administration")).toEqual([]);
  });

  it("syncs no medicine without the assigned claim (no medicines.emar.administer: fails closed)", async () => {
    for (const assigned of [false, undefined]) {
      const device = await syncFor(hydrated, source, claims({ meds_assigned: assigned }));
      expect(ids(device, "medication"), String(assigned)).toEqual([]);
      expect(ids(device, "medication_administration"), String(assigned)).toEqual([]);
    }
  });

  it("gives a nurse every live person's medicines at the token's locations, never a discharged person's or another home's", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "nurse", meds_assigned: false, meds_location_ids: [NORTH] }),
    );
    expect(ids(device, "medication")).toEqual([
      "m-ada",
      "m-ada-difference",
      "m-ada-replaced",
      "m-ada-stopped",
      "m-ada-unchecked",
      "m-bea",
    ]);
    expect(ids(device, "medication_administration")).toEqual([
      "a-ada-month",
      "a-ada-today",
      "a-ada-two-days",
      "a-bea-today",
    ]);
  });

  it("keeps each tenant's medicines to its own token, for the same member and location ids", async () => {
    const device = await syncFor(hydrated, source, claims({ tenant_id: B }));
    expect(ids(device, "medication")).toEqual(["m-eve"]);
    expect(ids(device, "medication_administration")).toEqual(["a-eve-today"]);
  });

  it("gives the member their own medicines competence only, with its withdrawals", async () => {
    const device = await syncFor(hydrated, source, claims());
    expect(ids(device, "competence_sign_off")).toEqual(["cs-carer"]);
    expect(ids(device, "competence_withdrawal")).toEqual(["cw-carer"]);
  });

  it("ignores whatever the device sends to widen the people, the days or the member", async () => {
    const device = await syncFor(hydrated, source, claims(), {
      sub: "colleague",
      meds_assigned: true,
      meds_location_ids: [NORTH, SOUTH],
      meds_recent_days: ["2026-11-01"],
      tenant_id: B,
    });
    expect(ids(device, "medication")).toEqual([
      "m-ada",
      "m-ada-difference",
      "m-ada-replaced",
      "m-ada-stopped",
      "m-ada-unchecked",
    ]);
    expect(ids(device, "medication_administration")).toEqual([
      "a-ada-month",
      "a-ada-today",
      "a-ada-two-days",
    ]);
    expect(ids(device, "competence_sign_off")).toEqual(["cs-carer"]);
  });

  it("keeps the medicines buckets per person, never per MAR entry version (security re-review, M1)", async () => {
    // Many versions for one person and others: the bucket count must not follow them.
    const many: SourceRows = {
      ...source,
      medication: [
        ...(source.medication ?? []),
        ...Array.from({ length: 40 }, (_, i) =>
          medication(`m-many-${i}`, A, i % 2 ? "ada" : "dee"),
        ),
      ],
    };
    for (const token of [
      claims(),
      claims({ sub: "nurse", meds_assigned: false, meds_location_ids: [NORTH, SOUTH] }),
    ]) {
      const device = await syncFor(hydrated, many, token);
      const meds = device.buckets.filter((b) => /^(assigned|location)_medicines\b/.test(b));
      // One bucket per person in scope (at most four people here), whatever the versions.
      expect(meds.length).toBeLessThanOrEqual(4);
    }
  });

  it("hazard HZ-002 sends medicines and allergies first", () => {
    const config = readSyncConfig();
    for (const stream of [
      "assigned_medicines",
      "location_medicines",
      "assigned_allergies",
      "location_allergies",
    ]) {
      expect(config, stream).toMatch(
        new RegExp(`  ${stream}:\\n    auto_subscribe: true\\n(    #.*\\n)?    priority: 1\\n`),
      );
    }
  });
});

describe("the medicines window", () => {
  it.each([
    ["midday", "2026-11-06T12:00:00Z", "2026-10-03", "2026-11-06"],
    ["just after midnight UTC", "2026-11-06T00:05:00Z", "2026-10-03", "2026-11-06"],
    ["just before midnight UTC", "2026-11-06T23:55:00Z", "2026-10-03", "2026-11-06"],
    ["across a year", "2027-01-10T09:00:00Z", "2026-12-07", "2027-01-10"],
    ["across a leap day", "2028-03-15T09:00:00Z", "2028-02-10", "2028-03-15"],
    ["on the day the clocks go back", "2026-10-25T00:30:00Z", "2026-09-21", "2026-10-25"],
    ["on the day the clocks go forward", "2027-03-28T01:30:00Z", "2027-02-22", "2027-03-28"],
  ])("covers today and the 34 UTC days before (%s)", (_case, now, first, last) => {
    const days = medsRecentDays(new Date(now));
    expect(days).toHaveLength(35);
    expect(days[0]).toBe(first);
    expect(days.at(-1)).toBe(last);
    expect(new Set(days).size).toBe(35);
    expect([...days].sort()).toEqual(days);
  });
});
