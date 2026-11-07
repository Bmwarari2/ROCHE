import { MEDICINES_RATE_KEYS } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { parseMedicinesRates } from "./rates";
import { planTimeCriticalReminders } from "./reminders";
import type { PersonRound } from "./round";
import { allergyLine, gateWords, packCheckWords, ukDateWords } from "./view";

describe("hazard HZ-007 allergies beside the medicine never read 'not recorded' as 'none'", () => {
  it.each([
    [
      "allergies on the phone",
      "has_allergies",
      [{ substance: "Penicillin", reaction: "Rash" }],
      "Allergies: Penicillin (Rash)",
      true,
    ],
    ["no known allergies", "no_known_allergies", [], "No known allergies", false],
    ["not recorded", "unknown", [], "Allergies not recorded", true],
    ["recorded but not on this phone", "has_allergies", [], "not on this phone yet", true],
  ] as const)("%s", (_case, status, rows, words, warning) => {
    const line = allergyLine(status, rows);
    expect(line.words).toContain(words);
    expect(line.warning).toBe(warning);
  });
});

describe("the round says why it is not offered, and what a scan found", () => {
  it("says why for each gate", () => {
    expect(gateWords({ kind: "ready" })).toBeNull();
    expect(gateWords({ kind: "waiting_for_sync" })).toMatch(/finished syncing/);
    expect(gateWords({ kind: "device_not_trusted", status: "compromised" })).toMatch(/rooted/);
  });

  it.each([
    [{ result: "matches", amppId: "1" }, true, "Pack checked"],
    [{ result: "different_product", amppId: "1" }, false, "Stop"],
    [{ result: "expired", expiry: "2026-01-31" }, false, "expired"],
    [{ result: "unknown_pack" }, false, "not in the medicines data"],
    ["unreadable", false, "Scan again"],
  ] as const)("%j", (check, matches, words) => {
    const out = packCheckWords(check);
    expect(out.matches).toBe(matches);
    expect(out.words).toContain(words);
  });

  it("writes dates as dd/mm/yyyy", () => {
    expect(ukDateWords("2026-11-03")).toBe("03/11/2026");
  });
});

describe("the medicines figures come from the rate table, all or none", () => {
  const all = Object.fromEntries(Object.keys(MEDICINES_RATE_KEYS).map((k) => [k, 1]));
  it("keeps a full set and refuses a partial one", () => {
    expect(parseMedicinesRates(JSON.stringify(all))).not.toBeNull();
    const { doseLateMinutes: _, ...partial } = all;
    expect(parseMedicinesRates(partial)).toBeNull();
    expect(parseMedicinesRates("not json")).toBeNull();
  });
});

describe("hazard HZ-003 reminders for time-critical doses name no one", () => {
  const dose = (opensAt: string, overrides: Record<string, unknown> = {}) => ({
    entryId: "e",
    productName: "Invented",
    dueAt: opensAt,
    date: "2026-11-03",
    time: "08:00",
    dayName: null,
    clockChange: null,
    doseInWords: "1 tablet",
    timeCritical: true,
    state: "not_yet_due" as const,
    stateInWords: "Not due yet",
    reviewPending: false,
    reviewInWords: null,
    opensAt,
    lateAfter: opensAt,
    notices: [],
    entryStatus: { words: "In force", mayGive: true, notice: null },
    ...overrides,
  });
  const round = (doses: ReturnType<typeof dose>[]): PersonRound => ({
    personId: "p",
    doses,
    whenRequired: [],
    unreadable: [],
    controlledDrugIds: new Set(),
  });
  it("plans one reminder a moment for unrecorded time-critical doses still to open", () => {
    const now = new Date("2026-11-03T07:00:00Z");
    const plan = planTimeCriticalReminders(
      [
        round([dose("2026-11-03T07:30:00.000Z"), dose("2026-11-03T06:30:00.000Z")]),
        round([
          dose("2026-11-03T07:30:00.000Z"),
          dose("2026-11-03T09:30:00.000Z", { timeCritical: false }),
          dose("2026-11-03T10:30:00.000Z", { state: "recorded" }),
        ]),
      ],
      now,
    );
    expect(plan.map((p) => p.at.toISOString())).toEqual(["2026-11-03T07:30:00.000Z"]);
    expect(plan[0]?.identifier).not.toContain("p");
  });
});
