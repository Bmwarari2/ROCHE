import { describe, expect, it } from "vitest";
import { readRateTable, tableOperationsRates } from "../../test/rate-table";
import { resolveRate } from "../platform/rates";
import { builtinRole } from "../platform/roles";
import {
  checkWorkflowTransition,
  slaDueAt,
  type WorkflowTransitionRequest,
} from "../platform/workflow";
import {
  BACK_ENTRY_MESSAGES,
  type BackEntryInput,
  type BackEntryProblem,
  type BackEntryRecord,
  backEntryLabel,
  checkBackEntry,
  checkOutageClosure,
  checkOutageDeclaration,
  checkOutageReconciliation,
  OUTAGE_DECLARATION_MESSAGES,
  OUTAGE_KIND_LABELS,
  OUTAGE_KINDS,
  OUTAGE_WORKFLOW,
  type OutageDeclaration,
  type OutageState,
  type OutageWindow,
  possibleDuplicateBackEntries,
} from "./outage";

/** Outages and back-entry (operations.md section 4 rules 5 to 9). Hazards HZ-017 and HZ-021. */

const rates = tableOperationsRates();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOCATION = "location-harbour-house";
const START = new Date("2026-10-11T13:40:00Z");
const END = new Date("2026-10-11T17:10:00Z");
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

const permissionsOf = (role: string) => new Set(builtinRole(role)?.permissions ?? []);

function outage(o: Partial<OutageWindow> = {}): OutageWindow {
  return {
    id: "outage-1",
    locationId: LOCATION,
    kind: "power",
    state: "closed",
    startedAt: START,
    endedAt: END,
    declaredAt: plus(START, 10 * MINUTE),
    declaredBy: "staff-senior",
    ...o,
  };
}

describe("outage kinds", () => {
  it("has a label in words for every kind", () => {
    for (const kind of OUTAGE_KINDS) expect(OUTAGE_KIND_LABELS[kind].length).toBeGreaterThan(5);
  });
});

describe("outage workflow", () => {
  function request(
    to: OutageState,
    o: Partial<WorkflowTransitionRequest<OutageState>> = {},
  ): WorkflowTransitionRequest<OutageState> {
    return {
      to,
      actorId: "staff-senior",
      permissions: permissionsOf("team_leader"),
      stepUpFresh: false,
      ...o,
    };
  }
  const at = (state: OutageState) => ({ state, createdBy: "staff-senior" });

  it.each<[string, OutageState, WorkflowTransitionRequest<OutageState>, string | null]>([
    ["the senior on shift closes an open outage", "declared", request("closed"), null],
    [
      "a care worker cannot close it",
      "declared",
      request("closed", { permissions: permissionsOf("care_worker") }),
      "missing_permission",
    ],
    ["reconciling needs a statement", "closed", request("reconciled"), "reason_required"],
    [
      "reconciling with a statement",
      "closed",
      request("reconciled", { reason: "All forms entered" }),
      null,
    ],
    ["cancelling needs a reason", "declared", request("cancelled"), "reason_required"],
    ["a reconciled outage is final", "reconciled", request("closed"), "terminal"],
    [
      "an open outage cannot be reconciled",
      "declared",
      request("reconciled", { reason: "x x x" }),
      "no_such_transition",
    ],
  ])("%s", (_label, state, req, problem) => {
    const check = checkWorkflowTransition(OUTAGE_WORKFLOW, at(state), req);
    expect(check.ok ? null : check.problem).toBe(problem);
  });

  it("sets the back-entry deadline from the rate table when the outage closes", () => {
    const rows = readRateTable();
    const due = slaDueAt(
      OUTAGE_WORKFLOW,
      "closed",
      END,
      (key) => resolveRate(rows, key, "england", "2026-10-11", null).value,
    );
    const closure = checkOutageClosure(
      outage({ state: "declared", endedAt: null }),
      { endedAt: END, closedAt: END },
      rates,
    );
    expect(closure.ok && closure.backEntryDueAt).toEqual(due);
  });
});

describe("declaring an outage", () => {
  function declaration(o: Partial<OutageDeclaration> = {}): OutageDeclaration {
    return {
      locationId: LOCATION,
      kind: "network",
      startedAt: START,
      declaredAt: plus(START, 15 * MINUTE),
      description: "Internet down across the building",
      ...o,
    };
  }

  it.each<[string, Partial<OutageDeclaration>, readonly OutageWindow[], string[] | null]>([
    ["a new outage", {}, [], null],
    [
      "one starting a minute in the future, within the clock-drift tolerance",
      { startedAt: plus(START, 16 * MINUTE) },
      [],
      null,
    ],
    [
      "one starting beyond the clock-drift tolerance",
      { startedAt: plus(START, 15 * MINUTE + (rates.clockDriftMinutes + 1) * MINUTE) },
      [],
      ["start_in_future"],
    ],
    ["one without a description", { description: " power " }, [], ["description_required"]],
    [
      "a second open outage at the same location",
      {},
      [outage({ id: "o-open", state: "declared", endedAt: null, startedAt: plus(START, -HOUR) })],
      ["already_open"],
    ],
    [
      "one overlapping an earlier closed outage",
      {},
      [
        outage({
          id: "o-early",
          startedAt: plus(START, -HOUR),
          endedAt: plus(START, 5 * MINUTE),
        }),
      ],
      ["overlaps_earlier_outage"],
    ],
    [
      "one after an earlier outage ended",
      {},
      [outage({ id: "o-early", startedAt: plus(START, -2 * HOUR), endedAt: plus(START, -HOUR) })],
      null,
    ],
    [
      "one beside a cancelled or another location's outage",
      {},
      [
        outage({ id: "o-cancelled", state: "cancelled", endedAt: null }),
        outage({ id: "o-elsewhere", state: "declared", endedAt: null, locationId: "location-2" }),
      ],
      null,
    ],
  ])("%s", (_label, o, existing, problems) => {
    const check = checkOutageDeclaration(declaration(o), existing, rates);
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("flags an outage declared well after it began", () => {
    const late = checkOutageDeclaration(
      declaration({ declaredAt: plus(START, (rates.lateEntryHours + 1) * HOUR) }),
      [],
      rates,
    );
    expect(late).toEqual({ ok: true, declaredLate: true });
    expect(checkOutageDeclaration(declaration(), [], rates)).toEqual({
      ok: true,
      declaredLate: false,
    });
  });

  it("has a message for every problem", () => {
    for (const message of Object.values(OUTAGE_DECLARATION_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe("closing an outage", () => {
  const open = outage({ state: "declared", endedAt: null });
  it.each<[string, OutageWindow, { endedAt: Date; closedAt: Date }, string[] | null]>([
    ["when systems are back", open, { endedAt: END, closedAt: plus(END, 5 * MINUTE) }, null],
    ["an outage already closed", outage(), { endedAt: END, closedAt: END }, ["not_open"]],
    [
      "an end before the start",
      open,
      { endedAt: plus(START, -MINUTE), closedAt: END },
      ["ends_before_start"],
    ],
    [
      "an end in the future",
      open,
      { endedAt: plus(END, (rates.clockDriftMinutes + 1) * MINUTE), closedAt: END },
      ["ends_in_future"],
    ],
  ])("%s", (_label, window, closure, problems) => {
    const check = checkOutageClosure(window, closure, rates);
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("makes the paper records due a set time after closure", () => {
    const closedAt = plus(END, 5 * MINUTE);
    const check = checkOutageClosure(open, { endedAt: END, closedAt }, rates);
    expect(check.ok && check.backEntryDueAt.getTime() - closedAt.getTime()).toBe(
      rates.backEntryDueHours * HOUR,
    );
  });
});

describe("hazard HZ-017 a back-entry carries the paper time, the downtime reason and its outage", () => {
  function entry(o: Partial<BackEntryInput> = {}): BackEntryInput {
    return {
      personId: "person-ada",
      locationId: LOCATION,
      eventAt: plus(START, 25 * MINUTE),
      recordedAt: plus(END, 70 * MINUTE),
      outageId: "outage-1",
      reason: null,
      paperReference: " DP-12 ",
      ...o,
    };
  }
  const outages = [
    outage(),
    outage({ id: "outage-cancelled", state: "cancelled" }),
    outage({ id: "outage-elsewhere", locationId: "location-2" }),
    outage({ id: "outage-open", state: "declared", endedAt: null }),
  ];

  it("accepts a paper record from inside the outage and labels it everywhere it appears", () => {
    const check = checkBackEntry(entry(), outages, rates);
    expect(check).toMatchObject({
      ok: true,
      lateEntryReason: "downtime",
      lateEntry: true,
      outageId: "outage-1",
      withinOutage: true,
      outsideReason: null,
      paperReference: "DP-12",
    });
    expect(check.ok && check.label).toBe(
      "Written on paper 11/10/2026 15:05 during the outage (power cut) from 11/10/2026 14:40. Entered in Harbour 11/10/2026 19:20.",
    );
  });

  it("labels a back-entry even when it is typed in before the late-entry threshold", () => {
    const check = checkBackEntry(
      entry({ recordedAt: plus(START, 40 * MINUTE), paperReference: null }),
      outages,
      rates,
    );
    expect(check).toMatchObject({ ok: true, lateEntry: false, paperReference: null });
    expect(check.ok && check.label).toMatch(/^Written on paper/);
  });

  it("accepts entries for an outage that is still open, up to the time of entry", () => {
    const check = checkBackEntry(
      entry({ outageId: "outage-open", recordedAt: plus(START, 3 * HOUR) }),
      outages,
      rates,
    );
    expect(check).toMatchObject({ ok: true, withinOutage: true });
  });

  it.each<[string, Partial<BackEntryInput>, BackEntryProblem[]]>([
    ["no outage chosen", { outageId: null }, ["outage_required"]],
    ["an outage that does not exist", { outageId: "outage-x" }, ["unknown_outage"]],
    ["a cancelled outage", { outageId: "outage-cancelled" }, ["outage_cancelled"]],
    [
      "hazard HZ-001 an outage at another location",
      { outageId: "outage-elsewhere" },
      ["other_location"],
    ],
    [
      "a paper time in the future",
      {
        eventAt: plus(END, 2 * HOUR),
        recordedAt: plus(END, HOUR),
        reason: "Night staff wrote it",
      },
      ["future_entry"],
    ],
    [
      "an entry typed in before the outage began",
      {
        recordedAt: plus(START, -MINUTE),
        eventAt: plus(START, -2 * HOUR),
        reason: "Mistyped day",
      },
      ["entered_before_outage"],
    ],
    [
      "a paper time before the outage, with no reason",
      { eventAt: plus(START, -30 * MINUTE) },
      ["outside_outage_window"],
    ],
    [
      "a paper time after the outage, with too short a reason",
      { eventAt: plus(END, 20 * MINUTE), reason: "late" },
      ["outside_outage_window"],
    ],
  ])("hazard HZ-017 refuses %s", (_label, o, problems) => {
    const check = checkBackEntry(entry(o), outages, rates);
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("hazard HZ-017 a back-entry outside the outage window needs a reason, and shows it", () => {
    const check = checkBackEntry(
      entry({
        eventAt: plus(START, -30 * MINUTE),
        reason: " Tablet froze before the outage was declared ",
      }),
      outages,
      rates,
    );
    expect(check).toMatchObject({
      ok: true,
      withinOutage: false,
      outsideReason: "Tablet froze before the outage was declared",
    });
    expect(check.ok && check.label).toBe(
      "Written on paper 11/10/2026 14:10 outside the declared outage (Tablet froze before the outage was declared). Entered in Harbour 11/10/2026 19:20.",
    );
  });

  it("includes the window's edges", () => {
    for (const eventAt of [START, END]) {
      expect(checkBackEntry(entry({ eventAt }), outages, rates)).toMatchObject({
        ok: true,
        withinOutage: true,
      });
    }
  });

  it("has a message for every problem", () => {
    for (const message of Object.values(BACK_ENTRY_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it("labels an outside entry without a reason in plain words", () => {
    expect(
      backEntryLabel({
        eventAt: START,
        recordedAt: END,
        outage: outage(),
        withinOutage: false,
        outsideReason: null,
      }),
    ).toBe(
      "Written on paper 11/10/2026 14:40 outside the declared outage. Entered in Harbour 11/10/2026 18:10.",
    );
  });
});

describe("hazard HZ-017 possible duplicate back-entries are listed for review", () => {
  function record(id: string, o: Partial<BackEntryRecord> = {}): BackEntryRecord {
    return {
      id,
      outageId: "outage-1",
      personId: "person-ada",
      entryKind: "observation.fluid",
      eventAt: new Date("2026-10-11T14:05:00Z"),
      paperReference: null,
      withinOutage: true,
      ...o,
    };
  }
  it.each<[string, BackEntryRecord[], string[][]]>([
    ["the same form time twice with no references", [record("a"), record("b")], [["a", "b"]]],
    [
      "the same form reference twice",
      [record("a", { paperReference: "DP-1" }), record("b", { paperReference: " dp-1 " })],
      [["a", "b"]],
    ],
    [
      "one with a reference and one without",
      [record("a", { paperReference: "DP-1" }), record("b")],
      [["a", "b"]],
    ],
    [
      "different forms at the same minute",
      [record("a", { paperReference: "DP-1" }), record("b", { paperReference: "DP-2" })],
      [],
    ],
    [
      "seconds apart within one minute",
      [record("a"), record("b", { eventAt: new Date("2026-10-11T14:05:40Z") })],
      [["a", "b"]],
    ],
    ["different people", [record("a"), record("b", { personId: "person-ben" })], []],
    ["different kinds", [record("a"), record("b", { entryKind: "care_note" })], []],
    [
      "different minutes",
      [record("a"), record("b", { eventAt: new Date("2026-10-11T14:06:00Z") })],
      [],
    ],
    ["a single entry", [record("a")], []],
  ])("%s", (_label, entries, groups) => {
    expect(possibleDuplicateBackEntries(entries)).toEqual(groups);
  });
});

describe("hazard HZ-017 reconciling an outage", () => {
  const entries: BackEntryRecord[] = [
    {
      id: "a",
      outageId: "outage-1",
      personId: "person-ada",
      entryKind: "care_note",
      eventAt: new Date("2026-10-11T14:05:00Z"),
      paperReference: null,
      withinOutage: true,
    },
    {
      id: "b",
      outageId: "outage-1",
      personId: "person-ada",
      entryKind: "care_note",
      eventAt: new Date("2026-10-11T14:05:00Z"),
      paperReference: null,
      withinOutage: true,
    },
    {
      id: "c",
      outageId: "outage-1",
      personId: "person-ben",
      entryKind: "observation.fluid",
      eventAt: new Date("2026-10-11T13:20:00Z"),
      paperReference: "DP-4",
      withinOutage: false,
    },
    {
      id: "z",
      outageId: "outage-other",
      personId: "person-cara",
      entryKind: "care_note",
      eventAt: new Date("2026-10-11T14:05:00Z"),
      paperReference: null,
      withinOutage: true,
    },
  ];

  it("summarises this outage's back-entries only", () => {
    const check = checkOutageReconciliation(outage(), entries, {
      statement: "All 3 forms entered and checked",
      reviewedEntryIds: ["a", "b"],
    });
    expect(check).toEqual({
      ok: true,
      summary: { backEntries: 3, outsideWindow: 1, people: 2, duplicateGroups: [["a", "b"]] },
    });
  });

  it.each<[string, OutageState, string | null, string[], string[]]>([
    [
      "hazard HZ-017 the outage cannot be reconciled while possible duplicates are unreviewed",
      "closed",
      "All forms entered and checked",
      ["a"],
      ["duplicates_unreviewed"],
    ],
    [
      "before the outage is closed",
      "declared",
      "All forms entered and checked",
      ["a", "b"],
      ["not_closed"],
    ],
    ["without a statement", "closed", "done", ["a", "b"], ["statement_required"]],
  ])("refuses %s", (_label, state, statement, reviewed, problems) => {
    const check = checkOutageReconciliation(outage({ state }), entries, {
      statement,
      reviewedEntryIds: reviewed,
    });
    expect(check.ok ? null : check.problems).toEqual(problems);
  });
});
