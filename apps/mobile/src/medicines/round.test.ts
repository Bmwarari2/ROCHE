import { fromUkWallClock, MEDICINES_RATE_KEYS, type MedicinesRates } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import {
  type AdministrationLocalRow,
  doseSlots,
  entryFromRows,
  type MedicationLocalRow,
  phoneHistoryFrom,
  phoneRound,
  roundGate,
  type ScheduleLocalRow,
} from "./round";

// Test figures only, never read as tenant figures: every medicines rate the round needs.
const rates = Object.fromEntries(
  Object.keys(MEDICINES_RATE_KEYS).map((k) => [k, k.endsWith("Minutes") ? 60 : 4]),
) as MedicinesRates;
const at = (day: number, hour: number) => fromUkWallClock(2026, 11, day, hour, 0);
const iso = (d: Date) => d.toISOString().replace("T", " ");

const med = (overrides: Partial<MedicationLocalRow> = {}): MedicationLocalRow => ({
  id: "m1",
  person_id: "p1",
  medicine_id: "med-1",
  version: 1,
  replaces_id: null,
  state: "active",
  vmp_id: "1000001",
  amp_id: null,
  product_name: "Invented tablets 10mg",
  route_code: "26643006",
  route_name: "Oral",
  directions: "regular",
  pattern_kind: "every_day",
  interval_days: null,
  weekdays: null,
  interval_weeks: null,
  anchor_on: null,
  day_of_month: null,
  prn_dose: null,
  prn_max_per_24h: null,
  tags: "[]",
  minimum_interval_minutes: null,
  indication: null,
  special_instructions: null,
  starts_at: iso(at(1, 0)),
  stops_at: null,
  stop_at: null,
  stop_effective_at: null,
  cd_schedule: null,
  check_outcome: "matches_source",
  replaced_by_id: null,
  replaced_from: null,
  origin: "transcribed",
  corrected_part_way_through: null,
  earlier_doses_due_on: null,
  earlier_doses_due_reason: null,
  ...overrides,
});
const time = (medicationId: string, t: string, quantity = "1"): ScheduleLocalRow => ({
  medication_id: medicationId,
  position: 0,
  time: t,
  dose_kind: "amount",
  quantity,
  from_quantity: null,
  to_quantity: null,
  unit_code: "428673006",
  unit_name: "tablet",
});
const slot = { from: at(3, 6), to: at(3, 12) };

describe("the phone reads the synced MAR as the API does (slice 69)", () => {
  it("maps a synced version to the domain's entry, holding an unchecked import", () => {
    expect(entryFromRows(med(), [time("m1", "08:00")])?.secondCheck).not.toBeNull();
    const imported = entryFromRows(med({ origin: "import", check_outcome: null }), []);
    expect(imported?.origin).toBe("import");
    expect(imported?.secondCheck).toBeNull();
  });

  it("names a version it cannot read rather than leaving it out", () => {
    const [round] = phoneRound({
      medications: [med({ origin: null })],
      schedules: [],
      administrations: [],
      rates,
      ...slot,
      now: at(3, 8),
    });
    expect(round?.unreadable).toEqual(["Invented tablets 10mg"]);
  });

  it("hazard HZ-003 a replaced version and its replacement never both give a dose", () => {
    const old = med({
      id: "m1",
      state: "replaced",
      replaced_by_id: "m2",
      replaced_from: iso(at(3, 0)),
    });
    const next = med({ id: "m2", version: 2, replaces_id: "m1", starts_at: iso(at(3, 0)) });
    const [round] = phoneRound({
      medications: [old, next],
      schedules: [time("m1", "08:00", "1"), time("m2", "08:00", "2")],
      administrations: [],
      rates,
      ...slot,
      now: at(3, 8),
    });
    const today = round?.doses.filter((d) => d.date === "2026-11-03") ?? [];
    expect(today.map((d) => d.entryId)).toEqual(["m2"]);
  });

  it("counts a dose this phone recorded and has not sent as recorded, and says it is not synced", () => {
    const prn = med({
      id: "m3",
      directions: "when_required",
      pattern_kind: null,
      prn_dose: JSON.stringify({
        kind: "amount",
        quantity: 1,
        unit: { code: "428673006", name: "tablet" },
      }),
      prn_max_per_24h: "4",
      minimum_interval_minutes: 240,
    });
    const given: AdministrationLocalRow = {
      id: "a1",
      person_id: "p1",
      medication_id: "m3",
      due_at: null,
      outcome: "given",
      quantity: "1",
      unit_code: "428673006",
      given_at: iso(at(3, 7)),
      administered_by: "member-1",
      supersedes_id: null,
      request: "{}",
    };
    const [round] = phoneRound({
      medications: [prn],
      schedules: [],
      administrations: [given],
      rates,
      ...slot,
      now: at(3, 8),
    });
    expect(round?.whenRequired[0]?.lastGiven?.synced).toBe(false);
    expect(round?.whenRequired[0]?.givenInLast24Hours).toBe(1);
  });

  it("reads the round slot by slot, yesterday's doses with no outcome first", () => {
    const rounds = phoneRound({
      medications: [med(), med({ id: "m9", person_id: "p2" })],
      schedules: [time("m1", "08:00"), time("m9", "10:00")],
      administrations: [],
      rates,
      ...slot,
      now: at(3, 7),
    });
    expect(doseSlots(rounds).map((s) => [s.date, s.time, s.doses[0]?.state])).toEqual([
      ["2026-11-02", "08:00", "late"],
      ["2026-11-02", "10:00", "late"],
      ["2026-11-03", "08:00", "due"],
      ["2026-11-03", "10:00", "not_yet_due"],
    ]);
  });

  it("knows the first day of administrations the phone holds", () => {
    expect(phoneHistoryFrom(new Date("2026-11-07T10:00:00Z")).toISOString()).toBe(
      "2026-10-04T00:00:00.000Z",
    );
  });
});

describe("hazard HZ-004 the round offers a dose only once every priority has synced", () => {
  it.each([
    ["a rooted or jailbroken phone", "compromised", true, rates, "device_not_trusted"],
    ["a phone whose integrity is unknown", "unknown", true, rates, "device_not_trusted"],
    ["a phone that has not completed a sync", "trusted", false, rates, "waiting_for_sync"],
    ["a phone without the medicines figures", "trusted", true, null, "waiting_for_figures"],
    ["a trusted, synced phone", "trusted", true, rates, "ready"],
  ] as const)("%s", (_case, integrity, hasSynced, figures, kind) => {
    expect(roundGate({ integrity, hasSynced, rates: figures }).kind).toBe(kind);
  });
});
