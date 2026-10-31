import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  dueLine,
  forPerson,
  nextReadIn,
  recordHref,
  roundCounts,
  roundShown,
  roundTaskActions,
  timeStateChip,
} from "./round";

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
      {
        area: null,
        stops: [stop(ADA, ["due", "overdue", "escalated", "upcoming", "closed", "paused"])],
      },
    ];
    expect(roundCounts(areas as never)).toEqual({ overdue: 2, due: 1, upcoming: 1, notKnown: 1 });
    expect(t("care.round.counts", { overdue: 0, due: 1, upcoming: 2, notKnown: 0 })).toBe(
      "None overdue, 1 due now, 2 still to come.",
    );
    expect(t("care.round.counts", { overdue: 1, due: 0, upcoming: 0, notKnown: 1 })).toBe(
      "1 overdue, none due now, none still to come, 1 in a state not known.",
    );
  });

  it("hazard HZ-009 says when a task is due in one whole sentence, naming the zone on 25/10/2026", () => {
    expect(
      dueLine(
        {
          dueAt: "2026-10-25T00:30:00Z",
          assigneeStaff: { id: ADA, displayName: "Nell Nurse", jobTitle: "Clinical lead" },
          planAction: { whenText: "at night" } as never,
        },
        t,
      ),
    ).toBe("Due 25/10/2026 01:30 BST, at night, for Nell Nurse, Clinical lead");
    expect(
      dueLine({ dueAt: "2026-10-25T01:30:00Z", assigneeStaff: null, planAction: null }, t),
    ).toBe("Due 25/10/2026 01:30 GMT");
  });

  it("hazard HZ-003 names the task and the person on every action", () => {
    expect(t("care.round.doneNamed", { title: "Turn", name: "Ada Example" })).toBe(
      "Done: Turn for Ada Example",
    );
    expect(t("care.round.reason", { title: "Turn", name: "Ada Example" })).toBe(
      "Why was Turn for Ada Example not done?",
    );
    expect(t("care.round.startNamed", { title: "Check the lift", name: "none" })).toBe(
      "Start Check the lift",
    );
  });

  it("opens the task's own record form where the task says which", () => {
    expect(recordHref({ kind: "repositioning", evidenceType: "observation", personId: ADA })).toBe(
      `/people/${ADA}/charts?record=repositioning`,
    );
    expect(recordHref({ kind: "activity", evidenceType: "activity_record", personId: ADA })).toBe(
      `/people/${ADA}/activities`,
    );
    expect(recordHref({ kind: "review", evidenceType: null, personId: ADA })).toBe(
      `/people/${ADA}`,
    );
    expect(recordHref({ kind: "review", evidenceType: null, personId: null })).toBeNull();
    // hazard HZ-020: a DoLS expiry reminder opens the person's DoLS register.
    expect(recordHref({ kind: "care.dols_expiry", evidenceType: null, personId: ADA })).toBe(
      `/people/${ADA}/dols`,
    );
  });

  it("hazard HZ-003 reads the round again when a task's state can next change, or within 5 minutes", () => {
    const now = Date.parse("2026-10-16T10:00:00Z");
    const soon = (dueAt: string) =>
      [
        {
          area: null,
          stops: [{ tasks: [{ windowStart: null, dueAt, windowEnd: null }] }],
        },
      ] as never;
    expect(nextReadIn(soon("2026-10-16T10:02:00Z"), now)).toBe(120_000);
    expect(nextReadIn(soon("2026-10-16T12:00:00Z"), now)).toBe(300_000);
    expect(nextReadIn(soon("2026-10-16T09:00:00Z"), now)).toBe(300_000);
  });
});
