import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { forPerson, roundCounts, roundShown, roundTaskActions, timeStateChip } from "./round";

const t = createTranslator("en-GB");
const ADA = "0194d000-0000-7000-8600-000000000001";
const BEN = "0194d000-0000-7000-8600-000000000002";

const task = (timeState: string) => ({ timeState }) as never;
const stop = (personId: string | null, states: string[]) =>
  ({ personId, roomLabel: null, person: null, tasks: states.map(task), notRounds: [] }) as never;

describe("the round view (care.md rule 8; CARE-013)", () => {
  it("is offered to those who read care plans", () => {
    expect(roundShown(["care.plan.read"])).toBe(true);
    expect(roundShown(["people.person.read"])).toBe(false);
  });

  it.each([
    ["upcoming", "neutral", "clock", "Still to come"],
    ["due", "due", "clock", "Due now"],
    ["overdue", "overdue", "circle-alert", "Overdue"],
    ["escalated", "overdue", "triangle-alert", "Overdue: escalated"],
    ["closed", "done", "circle-check", "Finished"],
    ["paused", "overdue", "triangle-alert", "State not known: check the task"],
  ])(
    "hazard HZ-003 says a %s task in an icon and words, never colour alone",
    (state, status, icon, label) => {
      expect(timeStateChip(state, t)).toEqual({ status, icon, label });
    },
  );

  it.each([
    [
      { status: "open", evidenceRequired: false },
      true,
      { start: true, done: true, recordFirst: false, skip: true },
    ],
    [
      { status: "in_progress", evidenceRequired: false },
      true,
      { start: false, done: true, recordFirst: false, skip: true },
    ],
    [
      { status: "open", evidenceRequired: true },
      true,
      { start: true, done: false, recordFirst: true, skip: true },
    ],
    [
      { status: "done", evidenceRequired: false },
      true,
      { start: false, done: false, recordFirst: false, skip: false },
    ],
    [
      { status: "open", evidenceRequired: false },
      false,
      { start: false, done: false, recordFirst: false, skip: false },
    ],
  ] as const)(
    "offers on %o (writes care: %s) only what the API would accept",
    (taskState, canWrite, out) => {
      expect(roundTaskActions(taskState, canWrite)).toEqual(out);
    },
  );

  it("hazard HZ-001 shows one person's stops when asked, dropping empty areas", () => {
    const areas = [
      { area: "Ground floor", stops: [stop(ADA, ["due"]), stop(BEN, ["overdue"])] },
      { area: "First floor", stops: [stop(BEN, ["upcoming"])] },
    ];
    expect(forPerson({ areas }, null)).toBe(areas);
    expect(forPerson({ areas }, ADA).map((a) => [a.area, a.stops.length])).toEqual([
      ["Ground floor", 1],
    ]);
  });

  it("counts the tasks shown by where they stand, escalated with overdue", () => {
    const areas = [
      { area: null, stops: [stop(ADA, ["due", "overdue", "escalated", "upcoming", "closed"])] },
    ];
    expect(roundCounts(areas as never)).toEqual({ overdue: 2, due: 1, upcoming: 1 });
    expect(t("care.round.counts", { overdue: 0, due: 1, upcoming: 2 })).toBe(
      "None overdue, 1 due now, 2 still to come.",
    );
  });
});
