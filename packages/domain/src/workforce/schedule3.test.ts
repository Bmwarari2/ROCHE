import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { addDays } from "./dates";
import { reminderDays, resolveWorkforceRates } from "./rates";
import {
  requiredItems,
  SCHEDULE3_ITEMS,
  type Schedule3Item,
  type Schedule3Role,
  schedule3State,
} from "./schedule3";

const offsets = reminderDays(resolveWorkforceRates(readRateTable(), "england", "2026-10-31", null));
const TODAY = "2026-10-31";
const carer: Schedule3Role = { registration: null, previousCareWork: false };
const nurse: Schedule3Role = { registration: "nmc", previousCareWork: true };

const all = (
  role: Schedule3Role,
  expiring: Partial<Record<string, string>> = {},
): Schedule3Item[] =>
  requiredItems(role).map((kind) => ({
    kind,
    satisfied: true,
    expiresOn: expiring[kind] ?? null,
  }));

describe("Schedule 3 pre-employment file (workforce.md rule 1)", () => {
  it.each([
    ["a care worker new to care", carer, SCHEDULE3_ITEMS.length - 2],
    ["a nurse who has worked in care", nurse, SCHEDULE3_ITEMS.length],
    [
      "a care worker who has worked in care",
      { registration: null, previousCareWork: true },
      SCHEDULE3_ITEMS.length - 1,
    ],
  ] as const)("%s needs %i items", (_, role, count) => {
    expect(requiredItems(role)).toHaveLength(count);
  });

  it("adds the NMC PIN for a registered nurse only", () => {
    expect(requiredItems(nurse)).toContain("professional_registration");
    expect(requiredItems(carer)).not.toContain("professional_registration");
  });

  it("is complete with every item satisfied and in date", () => {
    expect(schedule3State(carer, all(carer), TODAY, offsets)).toMatchObject({
      complete: true,
      outstanding: [],
    });
  });

  it.each([
    [
      "a missing reference",
      (items: Schedule3Item[]) => items.filter((i) => i.kind !== "references"),
      "references",
    ],
    [
      "an unsatisfied DBS certificate",
      (items: Schedule3Item[]) =>
        items.map((i) => (i.kind === "dbs_certificate" ? { ...i, satisfied: false } : i)),
      "dbs_certificate",
    ],
    [
      "an expired right to work",
      (items: Schedule3Item[]) =>
        items.map((i) =>
          i.kind === "right_to_work" ? { ...i, expiresOn: addDays(TODAY, -1) } : i,
        ),
      "right_to_work",
    ],
  ] as const)("is not complete with %s", (_, change, kind) => {
    const state = schedule3State(carer, change(all(carer)), TODAY, offsets);
    expect(state.complete).toBe(false);
    expect(state.outstanding).toEqual([kind]);
  });

  it("counts an item due soon as present, with a reminder raised once", () => {
    const [first] = offsets as [number];
    const items = all(nurse, { professional_registration: addDays(TODAY, first) });
    const state = schedule3State(nurse, items, TODAY, offsets);
    expect(state.complete).toBe(true);
    expect(state.items.find((i) => i.kind === "professional_registration")?.status).toBe(
      "due_soon",
    );
    expect(state.reminders).toEqual([{ kind: "professional_registration", days: first }]);
    const sent = items.map((i) =>
      i.kind === "professional_registration" ? { ...i, remindersSent: [first] } : i,
    );
    expect(schedule3State(nurse, sent, TODAY, offsets).reminders).toEqual([]);
  });

  it("ignores items the role does not need", () => {
    const extra: Schedule3Item[] = [
      ...all(carer),
      { kind: "professional_registration", satisfied: false, expiresOn: null },
    ];
    expect(schedule3State(carer, extra, TODAY, offsets).complete).toBe(true);
  });
});
