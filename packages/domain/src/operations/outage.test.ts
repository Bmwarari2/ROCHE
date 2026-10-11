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
  backEntryLabel,
  type CareEntryOutageInput,
  checkBackEntry,
  checkEntryAgainstOutages,
  checkOutageClosure,
  checkOutageDeclaration,
  checkOutageReconciliation,
  OUTAGE_DECLARATION_MESSAGES,
  OUTAGE_KIND_LABELS,
  OUTAGE_KINDS,
  OUTAGE_RECONCILIATION_MESSAGES,
  OUTAGE_WORKFLOW,
  type OutageDeclaration,
  type OutageEntryRecord,
  type OutageState,
  type OutageWindow,
  type PaperTimeResolution,
  possibleDuplicateBackEntries,
  resolvePaperTime,
} from "./outage";

/**
 * Outages and back-entry (operations.md section 4 rules 9 to 15). Hazards HZ-017 and HZ-021, with
 * HZ-009 for paper times written during a clock change and HZ-001 for the location check.
 */

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

/** A paper time already resolved (the helper is tested on its own below). */
function paper(instant: Date): PaperTimeResolution {
  return { ok: true, instant, written: { date: "2026-10-11", time: "00:00" }, occurrence: "only" };
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
      endedAt: null,
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
    [
      "one declared after it ended, ending before it started",
      { endedAt: plus(START, -MINUTE) },
      [],
      ["ends_before_start"],
    ],
    [
      "one declared after it ended, ending in the future",
      { endedAt: plus(START, 15 * MINUTE + (rates.clockDriftMinutes + 1) * MINUTE) },
      [],
      ["ends_in_future"],
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
      [outage({ id: "o-early", startedAt: plus(START, -HOUR), endedAt: plus(START, 5 * MINUTE) })],
      ["overlaps_another_outage"],
    ],
    [
      "one after an earlier outage ended",
      {},
      [outage({ id: "o-early", startedAt: plus(START, -2 * HOUR), endedAt: plus(START, -HOUR) })],
      null,
    ],
    [
      "an earlier outage declared late while a later one is open, without overlapping",
      { startedAt: plus(START, -6 * HOUR), endedAt: plus(START, -5 * HOUR), declaredAt: START },
      [outage({ id: "o-later", state: "declared", startedAt: plus(START, -HOUR), endedAt: null })],
      null,
    ],
    [
      "an earlier outage declared late that runs into a later one",
      { startedAt: plus(START, -6 * HOUR), endedAt: plus(START, -30 * MINUTE), declaredAt: START },
      [outage({ id: "o-later", state: "closed", startedAt: plus(START, -HOUR), endedAt: START })],
      ["overlaps_another_outage"],
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

describe("paper times written during a clock change", () => {
  const options = {
    now: new Date("2026-10-26T12:00:00Z"),
    clockDriftMinutes: rates.clockDriftMinutes,
  };
  it.each<[string, { date: string; time: string }, object]>([
    [
      "hazard HZ-009 hazard HZ-017 a time in the hour skipped on 29/03/2026 is refused",
      { date: "2026-03-29", time: "01:30" },
      { ok: false, problem: "skipped" },
    ],
    [
      "hazard HZ-009 hazard HZ-017 the hour after the spring change is an ordinary summer time",
      { date: "2026-03-29", time: "02:30" },
      { ok: true, instant: new Date("2026-03-29T01:30:00Z"), occurrence: "only" },
    ],
    [
      "hazard HZ-009 hazard HZ-017 a time in the hour repeated on 25/10/2026 asks which one",
      { date: "2026-10-25", time: "01:30" },
      {
        ok: false,
        problem: "ambiguous",
        choices: {
          earlier: new Date("2026-10-25T00:30:00Z"),
          later: new Date("2026-10-25T01:30:00Z"),
        },
      },
    ],
    [
      "hazard HZ-009 hazard HZ-017 the hour after the autumn change is an ordinary winter time",
      { date: "2026-10-25", time: "02:30" },
      { ok: true, instant: new Date("2026-10-25T02:30:00Z") },
    ],
    [
      "an impossible date",
      { date: "2026-02-30", time: "10:00" },
      { ok: false, problem: "invalid" },
    ],
    [
      "a time with seconds",
      { date: "2026-10-11", time: "10:00:00" },
      { ok: false, problem: "invalid" },
    ],
    ["a mangled date", { date: "11/10/2026", time: "10:00" }, { ok: false, problem: "invalid" }],
    [
      "letters in the time",
      { date: "2026-10-11", time: "1a:00" },
      { ok: false, problem: "invalid" },
    ],
    ["an hour of 25", { date: "2026-10-11", time: "25:00" }, { ok: false, problem: "invalid" }],
    ["a future time", { date: "2026-10-27", time: "09:00" }, { ok: false, problem: "future" }],
  ])("%s", (_label, written, expected) => {
    expect(resolvePaperTime(written, options)).toMatchObject(expected);
  });

  it.each<["earlier" | "later", string]>([
    ["earlier", "2026-10-25T00:30:00Z"],
    ["later", "2026-10-25T01:30:00Z"],
  ])(
    "hazard HZ-009 hazard HZ-017 resolves the repeated hour to the %s time the person chose",
    (occurrence, iso) => {
      expect(
        resolvePaperTime({ date: "2026-10-25", time: " 01:30 " }, { ...options, occurrence }),
      ).toMatchObject({ ok: true, instant: new Date(iso), occurrence });
    },
  );

  it("hazard HZ-009 a time before the autumn change resolves to summer time", () => {
    expect(resolvePaperTime({ date: "2026-10-24", time: "23:15" }, options)).toMatchObject({
      ok: true,
      instant: new Date("2026-10-24T22:15:00Z"),
    });
  });
});

describe("hazard HZ-017 a back-entry carries the paper time, the downtime reason and its outage", () => {
  function entry(o: Partial<BackEntryInput> = {}): BackEntryInput {
    return {
      personId: "person-ada",
      locationId: LOCATION,
      paperTime: paper(plus(START, 25 * MINUTE)),
      recordedAt: plus(END, 70 * MINUTE),
      receivedAt: plus(END, 71 * MINUTE),
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

  it("accepts a paper record from inside the outage and labels it with the device and server times", () => {
    const check = checkBackEntry(entry(), outages, rates);
    expect(check).toMatchObject({
      ok: true,
      eventAt: plus(START, 25 * MINUTE),
      lateEntryReason: "downtime",
      lateEntry: true,
      outageId: "outage-1",
      withinOutage: true,
      outsideReason: null,
      paperReference: "DP-12",
    });
    expect(check.ok && check.label).toBe(
      "Written on paper 11/10/2026 15:05 during the outage (power cut) from 11/10/2026 14:40. Entered in Harbour 11/10/2026 19:20 on the device, received 11/10/2026 19:21.",
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
        paperTime: paper(plus(END, 2 * HOUR)),
        recordedAt: plus(END, HOUR),
        reason: "Night staff wrote it",
      },
      ["future_entry"],
    ],
    [
      "an entry typed in before the outage began",
      {
        recordedAt: plus(START, -MINUTE),
        paperTime: paper(plus(START, -2 * HOUR)),
        reason: "Mistyped day",
      },
      ["entered_before_outage"],
    ],
    [
      "a paper time before the outage, with no reason",
      { paperTime: paper(plus(START, -30 * MINUTE)) },
      ["outside_outage_window"],
    ],
    [
      "a paper time after the outage, with too short a reason",
      { paperTime: paper(plus(END, 20 * MINUTE)), reason: "late" },
      ["outside_outage_window"],
    ],
    [
      "hazard HZ-009 a paper time in the skipped spring hour",
      {
        paperTime: {
          ok: false,
          problem: "skipped",
          written: { date: "2026-03-29", time: "01:30" },
          choices: null,
        },
      },
      ["paper_time_skipped"],
    ],
    [
      "hazard HZ-009 a paper time in the repeated autumn hour with no choice made",
      {
        paperTime: resolvePaperTime(
          { date: "2026-10-25", time: "01:30" },
          { now: new Date("2026-10-26T09:00:00Z"), clockDriftMinutes: rates.clockDriftMinutes },
        ),
      },
      ["paper_time_ambiguous"],
    ],
    [
      "an unreadable paper time",
      {
        paperTime: {
          ok: false,
          problem: "invalid",
          written: { date: "x", time: "y" },
          choices: null,
        },
      },
      ["paper_time_invalid"],
    ],
    [
      "a paper time the helper found to be in the future",
      {
        paperTime: {
          ok: false,
          problem: "future",
          written: { date: "2026-12-01", time: "10:00" },
          choices: null,
        },
      },
      ["future_entry"],
    ],
  ])("refuses %s", (_label, o, problems) => {
    const check = checkBackEntry(entry(o), outages, rates);
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("hazard HZ-017 a back-entry outside the outage window needs a reason, and shows it", () => {
    const check = checkBackEntry(
      entry({
        paperTime: paper(plus(START, -30 * MINUTE)),
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
      "Written on paper 11/10/2026 14:10 outside the declared outage (Tablet froze before the outage was declared). Entered in Harbour 11/10/2026 19:20 on the device, received 11/10/2026 19:21.",
    );
  });

  it("includes the window's edges", () => {
    for (const at of [START, END]) {
      expect(checkBackEntry(entry({ paperTime: paper(at) }), outages, rates)).toMatchObject({
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
        receivedAt: END,
        outage: outage(),
        withinOutage: false,
        outsideReason: null,
      }),
    ).toBe(
      "Written on paper 11/10/2026 14:40 outside the declared outage. Entered in Harbour 11/10/2026 18:10 on the device, received 11/10/2026 18:10.",
    );
  });
});

describe("hazard HZ-017 an entry through the normal route for a time inside an outage must say whether it is from paper", () => {
  const outages = [
    outage(),
    outage({
      id: "outage-cancelled",
      state: "cancelled",
      startedAt: plus(START, -10 * HOUR),
      endedAt: plus(START, -9 * HOUR),
    }),
  ];
  function care(o: Partial<CareEntryOutageInput> = {}): CareEntryOutageInput {
    return {
      locationId: LOCATION,
      eventAt: plus(START, HOUR),
      recordedAt: plus(END, 2 * HOUR),
      hasBackEntryDetails: false,
      notFromPaperReason: null,
      ...o,
    };
  }

  it.each<[string, Partial<CareEntryOutageInput>, string | null]>([
    ["a copied paper record with no back-entry details", {}, "back_entry_details_required"],
    ["a copied paper record entered as a back-entry", { hasBackEntryDetails: true }, null],
    [
      "a late entry that says it is not from paper",
      { notFromPaperReason: "Remembered at handover, no form was used" },
      null,
    ],
    ["a reason that is too short", { notFromPaperReason: "memory" }, "back_entry_details_required"],
    [
      "a device that kept working offline during the outage, written at the time",
      { recordedAt: plus(START, HOUR + 5 * MINUTE) },
      null,
    ],
    [
      "written within the late-entry threshold but after systems came back",
      { eventAt: plus(END, -10 * MINUTE), recordedAt: plus(END, 10 * MINUTE) },
      "back_entry_details_required",
    ],
    [
      "a time outside any outage",
      { eventAt: plus(END, 3 * HOUR), recordedAt: plus(END, 4 * HOUR) },
      null,
    ],
    ["another location", { locationId: "location-2" }, null],
    ["a time inside a cancelled outage", { eventAt: plus(START, -9.5 * HOUR) }, null],
  ])("%s", (_label, o, problem) => {
    const check = checkEntryAgainstOutages(care(o), outages, rates);
    expect(check.ok ? null : check.problem).toBe(problem);
  });

  it("names the outage in the message", () => {
    const check = checkEntryAgainstOutages(care(), outages, rates);
    expect(check.ok ? null : check.message).toMatch(
      /^This time falls in the outage from 11\/10\/2026 14:40/,
    );
    expect(checkEntryAgainstOutages(care({ hasBackEntryDetails: true }), outages, rates)).toEqual({
      ok: true,
      outageId: "outage-1",
    });
  });
});

function record(id: string, o: Partial<OutageEntryRecord> = {}): OutageEntryRecord {
  return {
    id,
    locationId: LOCATION,
    personId: "person-ada",
    entryKind: "observation.fluid",
    eventAt: new Date("2026-10-11T14:05:00Z"),
    source: "back_entry",
    outageId: "outage-1",
    paperReference: null,
    withinOutage: true,
    enteredBy: "staff-carer",
    ...o,
  };
}

describe("hazard HZ-017 possible duplicates are listed for review, paper against paper and paper against digital", () => {
  const minutes = (n: number) => new Date(new Date("2026-10-11T14:05:00Z").getTime() + n * MINUTE);
  it.each<[string, OutageEntryRecord[], string[][]]>([
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
      "different forms close together",
      [record("a", { paperReference: "DP-1" }), record("b", { paperReference: "DP-2" })],
      [],
    ],
    [
      "a paper form and a digital entry recorded offline a few minutes apart",
      [
        record("paper", { eventAt: minutes(0) }),
        record("tablet", { source: "digital", outageId: null, eventAt: minutes(4) }),
      ],
      [["paper", "tablet"]],
    ],
    [
      "a paper form and a digital entry further apart than the match window",
      [
        record("paper", { eventAt: minutes(0) }),
        record("tablet", {
          source: "digital",
          outageId: null,
          eventAt: minutes(rates.duplicateMatchMinutes + 1),
        }),
      ],
      [],
    ],
    [
      "two digital entries (ordinary records, not a back-entry question)",
      [
        record("t1", { source: "digital", outageId: null }),
        record("t2", { source: "digital", outageId: null }),
      ],
      [],
    ],
    [
      "a chain of entries each within the window of the next",
      [
        record("a", { eventAt: minutes(0) }),
        record("b", {
          source: "digital",
          outageId: null,
          eventAt: minutes(rates.duplicateMatchMinutes),
        }),
        record("c", { eventAt: minutes(2 * rates.duplicateMatchMinutes) }),
      ],
      [["a", "b", "c"]],
    ],
    ["different people", [record("a"), record("b", { personId: "person-ben" })], []],
    ["different kinds", [record("a"), record("b", { entryKind: "care_note" })], []],
    ["a single entry", [record("a")], []],
  ])("%s", (_label, entries, groups) => {
    expect(possibleDuplicateBackEntries(entries, rates)).toEqual(groups);
  });
});

describe("hazard HZ-017 reconciling an outage", () => {
  const entries: OutageEntryRecord[] = [
    record("a", { entryKind: "care_note", enteredBy: "staff-carer", paperReference: "DP-1" }),
    record("b", { entryKind: "care_note", enteredBy: "staff-senior", paperReference: "DP-1" }),
    record("c", {
      personId: "person-ben",
      eventAt: new Date("2026-10-11T13:20:00Z"),
      withinOutage: false,
      paperReference: "DP-4",
    }),
    record("d", { personId: "person-ben", eventAt: new Date("2026-10-11T15:00:00Z") }),
    record("tablet", {
      personId: "person-ben",
      source: "digital",
      outageId: null,
      enteredBy: "staff-nurse",
      eventAt: new Date("2026-10-11T15:03:00Z"),
    }),
    record("tablet-later", {
      personId: "person-cara",
      source: "digital",
      outageId: null,
      eventAt: new Date("2026-10-11T20:00:00Z"),
    }),
    record("tablet-elsewhere", {
      locationId: "location-2",
      source: "digital",
      outageId: null,
      eventAt: new Date("2026-10-11T14:05:00Z"),
    }),
    record("z", { outageId: "outage-other", personId: "person-cara" }),
  ];
  const confirmation = {
    by: "staff-manager",
    statement: "All 3 forms entered and checked",
    reviewedEntryIds: ["a", "b", "d", "tablet"],
  };

  it("summarises this outage's back-entries and the digital entries near it", () => {
    expect(checkOutageReconciliation(outage(), entries, confirmation, rates)).toEqual({
      ok: true,
      summary: {
        backEntries: 4,
        formsEntered: 2,
        entriesWithoutReference: 1,
        outsideWindow: 1,
        people: 2,
        digitalEntriesInWindow: 1,
        duplicateGroups: [
          ["a", "b"],
          ["d", "tablet"],
        ],
      },
    });
  });

  it.each<[string, Partial<OutageWindow>, Partial<typeof confirmation>, string[]]>([
    [
      "hazard HZ-017 while possible duplicates, paper or digital, are unreviewed",
      {},
      { reviewedEntryIds: ["a", "b"] },
      ["duplicates_unreviewed"],
    ],
    ["before the outage is closed", { state: "declared" }, {}, ["not_closed"]],
    ["without a statement", {}, { statement: "done" }, ["statement_required"]],
    [
      "hazard HZ-017 by someone who entered paper records",
      {},
      { by: "staff-senior" },
      ["reconciler_entered_records"],
    ],
  ])("refuses %s", (_label, window, conf, problems) => {
    const check = checkOutageReconciliation(
      outage(window),
      entries,
      { ...confirmation, ...conf },
      rates,
    );
    expect(check.ok ? null : check.problems).toEqual(problems);
  });

  it("compares digital entries up to the time of reconciliation while an outage has no end", () => {
    const check = checkOutageReconciliation(
      outage({ endedAt: null }),
      entries,
      confirmation,
      rates,
    );
    expect(check.summary.digitalEntriesInWindow).toBe(2);
  });

  it("explains every problem", () => {
    for (const m of Object.values(OUTAGE_RECONCILIATION_MESSAGES))
      expect(m.length).toBeGreaterThan(10);
  });
});
