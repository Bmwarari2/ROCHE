import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import type { EscalationStep } from "../platform/notifications";
import {
  ALARM_REASON_WORDS,
  ALARM_STATE_WORDS,
  acceptEvent,
  checkAcknowledge,
  checkRoute,
  checkSession,
  kindShownToWorker,
  LONE_WORKER_ALARM_REASONS,
  LONE_WORKER_ALARM_STATES,
  LONE_WORKER_RATE_KEYS,
  type LoneWorkerEventKind,
  type LoneWorkerSessionTimes,
  nextCheckInDue,
  realertDue,
  resolveOnCheckIn,
  sessionStatus,
} from "./lone-worker";

/**
 * Invented timings, passed in as a tenant's rate rows would be. The tests never assume the shipped
 * figures (docs/specs/rates.md is the only home of those).
 */
const TIMINGS = { graceMinutes: 15, offlineFlagMinutes: 10, clockDriftMinutes: 5 };
const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00Z`);

const SESSION: LoneWorkerSessionTimes = {
  startedAt: at("22:00"),
  plannedEndAt: new Date("2026-11-03T06:00:00Z"),
  intervalMinutes: 60,
  finishedAt: null,
};

describe("checkSession", () => {
  const bounds = {
    intervalMinMinutes: 15,
    intervalMaxMinutes: 240,
    sessionMaxHours: 14,
    clockDriftMinutes: 5,
  };
  const now = at("22:00");
  it.each([
    ["a usual night", 60, "22:00", "2026-11-03T06:00:00Z", []],
    ["the minimum interval", 15, "22:00", "2026-11-02T23:00:00Z", []],
    ["below the minimum", 14, "22:00", "2026-11-02T23:00:00Z", ["interval_too_short"]],
    ["above the maximum", 241, "22:00", "2026-11-03T06:00:00Z", ["interval_too_long"]],
    ["part minutes", 30.5, "22:00", "2026-11-03T06:00:00Z", ["interval_not_whole"]],
    ["end before start", 60, "22:00", "2026-11-02T21:00:00Z", ["end_not_after_start"]],
    ["longer than allowed", 60, "22:00", "2026-11-03T12:01:00Z", ["too_long"]],
    ["started a little ahead (drift)", 60, "22:04", "2026-11-03T06:00:00Z", []],
    ["started in the future", 60, "22:06", "2026-11-03T06:00:00Z", ["start_in_future"]],
  ] as const)("%s", (_label, interval, start, end, expected) => {
    expect(
      checkSession(
        { startedAt: at(start), plannedEndAt: new Date(end), intervalMinutes: interval },
        bounds,
        now,
      ),
    ).toEqual(expected);
  });
});

describe("hazard HZ-125 acceptEvent: offline and late events", () => {
  const cases: {
    label: string;
    kind: LoneWorkerEventKind;
    device: string;
    received: string;
    finishedAt?: string;
    expected:
      | { accepted: true; effectiveAt: string; late: boolean }
      | { accepted: false; refusal: string };
  }[] = [
    {
      label: "online check-in",
      kind: "check_in",
      device: "23:00",
      received: "23:00",
      expected: { accepted: true, effectiveAt: "23:00", late: false },
    },
    {
      label: "sent 9 minutes late is not flagged",
      kind: "check_in",
      device: "23:00",
      received: "23:09",
      expected: { accepted: true, effectiveAt: "23:00", late: false },
    },
    {
      label: "sent 10 minutes late is flagged as offline",
      kind: "check_in",
      device: "23:00",
      received: "23:10",
      expected: { accepted: true, effectiveAt: "23:00", late: true },
    },
    {
      label: "sent hours late is accepted from its device time",
      kind: "check_in",
      device: "23:00",
      received: "23:59",
      expected: { accepted: true, effectiveAt: "23:00", late: true },
    },
    {
      label: "device clock a little ahead is clamped to receipt",
      kind: "check_in",
      device: "23:04",
      received: "23:00",
      expected: { accepted: true, effectiveAt: "23:00", late: false },
    },
    {
      label: "device clock far ahead is refused",
      kind: "check_in",
      device: "23:06",
      received: "23:00",
      expected: { accepted: false, refusal: "in_future" },
    },
    {
      label: "before the session is refused",
      kind: "check_in",
      device: "21:54",
      received: "22:30",
      expected: { accepted: false, refusal: "before_start" },
    },
    {
      label: "after finishing is refused",
      kind: "check_in",
      device: "23:30",
      received: "23:30",
      finishedAt: "23:00",
      expected: { accepted: false, refusal: "after_finish" },
    },
    {
      label: "made offline before the finish, sent after it, is accepted",
      kind: "check_in",
      device: "22:50",
      received: "23:30",
      finishedAt: "23:00",
      expected: { accepted: true, effectiveAt: "22:50", late: true },
    },
    {
      label: "help after finishing is still accepted",
      kind: "help",
      device: "23:30",
      received: "23:30",
      finishedAt: "23:00",
      expected: { accepted: true, effectiveAt: "23:30", late: false },
    },
    {
      label: "duress with a clock far ahead counts from receipt",
      kind: "duress",
      device: "23:50",
      received: "23:00",
      expected: { accepted: true, effectiveAt: "23:00", late: false },
    },
    {
      label: "help sent late from an offline device keeps its device time",
      kind: "help",
      device: "23:00",
      received: "23:20",
      expected: { accepted: true, effectiveAt: "23:00", late: true },
    },
  ];
  it.each(cases)("$label", ({ kind, device, received, finishedAt, expected }) => {
    const result = acceptEvent(
      { kind, deviceAt: at(device), receivedAt: at(received) },
      { startedAt: SESSION.startedAt, finishedAt: finishedAt ? at(finishedAt) : null },
      TIMINGS,
    );
    if (expected.accepted) {
      expect(result).toEqual({
        accepted: true,
        effectiveAt: at(expected.effectiveAt),
        late: expected.late,
      });
    } else {
      expect(result).toEqual(expected);
    }
  });
});

describe("nextCheckInDue", () => {
  it.each([
    ["no check-in yet: one interval after the start", [], "23:00", "overdue"],
    ["after one check-in", ["22:40"], "23:40", "overdue"],
    ["out-of-order arrivals never move it back", ["23:30", "22:40"], "2026-11-03T00:30", "overdue"],
  ] as const)("%s", (_label, checkIns, due, reason) => {
    const result = nextCheckInDue(
      SESSION,
      checkIns.map((c) => at(c)),
    );
    expect(result.dueAt).toEqual(due.includes("T") ? new Date(`${due}:00Z`) : at(due));
    expect(result.reason).toBe(reason);
  });

  it("is never later than the planned end", () => {
    const result = nextCheckInDue(SESSION, [new Date("2026-11-03T05:30:00Z")]);
    expect(result).toEqual({ dueAt: SESSION.plannedEndAt, reason: "not_finished" });
  });

  it("a check-in after the planned end (staying on) restarts the interval", () => {
    const result = nextCheckInDue(SESSION, [new Date("2026-11-03T06:10:00Z")]);
    expect(result).toEqual({ dueAt: new Date("2026-11-03T07:10:00Z"), reason: "not_finished" });
  });
});

describe("sessionStatus: when the sweep reminds and when it raises the alarm", () => {
  it.each([
    ["before the check-in is due", [], "22:59", "ok"],
    ["due: remind the worker", [], "23:00", "due"],
    ["still within grace", [], "23:14", "due"],
    ["grace over: alarm", [], "23:15", "alarm"],
    ["an on-time check-in that arrived late resets the clock", ["22:58"], "23:20", "ok"],
  ] as const)("%s", (_label, checkIns, now, kind) => {
    expect(
      sessionStatus(
        SESSION,
        checkIns.map((c) => at(c)),
        TIMINGS,
        at(now),
      ).kind,
    ).toBe(kind);
  });

  it("a finished session never raises an alarm", () => {
    expect(
      sessionStatus({ ...SESSION, finishedAt: at("22:30") }, [], TIMINGS, at("23:59")).kind,
    ).toBe("finished");
  });

  it("the planned end without finishing raises a not-finished alarm", () => {
    const status = sessionStatus(
      SESSION,
      [new Date("2026-11-03T05:30:00Z")],
      TIMINGS,
      new Date("2026-11-03T06:15:00Z"),
    );
    expect(status).toMatchObject({ kind: "alarm", reason: "not_finished" });
  });
});

/**
 * The offline rule, end to end (scheduling.md section 15.4). Each row is a worker whose device
 * may be offline: the check-ins they made (device time) with when the server received each, and
 * what the server shows at the time it looks.
 */
describe("hazard HZ-125 the offline rule: no false alarm from a sync gap, no silence from a hurt worker", () => {
  const rows: {
    label: string;
    events: { device: string; received: string }[];
    now: string;
    expected: "ok" | "due" | "alarm";
  }[] = [
    {
      label: "offline but checked in on time; the check-in arrives within grace: no alarm",
      events: [{ device: "22:59", received: "23:12" }],
      now: "23:13",
      expected: "ok",
    },
    {
      label: "offline, checked in on time, nothing arrived yet, grace not over: reminder only",
      events: [],
      now: "23:10",
      expected: "due",
    },
    {
      label: "silence past grace raises the alarm: offline and hurt look the same",
      events: [],
      now: "23:15",
      expected: "alarm",
    },
    {
      label: "check-ins queued offline arrive together; the latest counts",
      events: [
        { device: "22:55", received: "23:50" },
        { device: "23:45", received: "23:50" },
      ],
      now: "23:51",
      expected: "ok",
    },
  ];
  it.each(rows)("$label", ({ events, now, expected }) => {
    const effective = events
      .filter((e) => at(e.received).getTime() <= at(now).getTime())
      .map((e) =>
        acceptEvent(
          { kind: "check_in", deviceAt: at(e.device), receivedAt: at(e.received) },
          SESSION,
          TIMINGS,
        ),
      )
      .flatMap((a) => (a.accepted ? [a.effectiveAt] : []));
    expect(sessionStatus(SESSION, effective, TIMINGS, at(now)).kind).toBe(expected);
  });
});

describe("hazard HZ-125 resolveOnCheckIn", () => {
  const raisedAt = at("23:15");
  const ok = { kind: "ok" as const, dueAt: at("23:59") };
  const stillAlarm = {
    kind: "alarm" as const,
    dueAt: at("23:00"),
    alarmAt: at("23:15"),
    reason: "overdue" as const,
  };
  it.each([
    [
      "an overdue alarm, check-in after it was raised",
      "overdue",
      "23:20",
      ok,
      "resolved_by_check_in",
    ],
    [
      "an overdue alarm, offline check-in made before it was raised",
      "overdue",
      "23:05",
      ok,
      "resolved_late_check_in",
    ],
    ["a not-finished alarm, check-in", "not_finished", "23:20", ok, "resolved_by_check_in"],
    ["a duress alarm: a check-in never closes it", "duress", "23:20", ok, "stays_open"],
    ["a help alarm: a check-in never closes it", "help", "23:20", ok, "stays_open"],
    [
      "safe then but overdue again now: the alarm stays open",
      "overdue",
      "21:00",
      stillAlarm,
      "stays_open",
    ],
  ] as const)("%s", (_label, reason, checkIn, after, expected) => {
    const result = resolveOnCheckIn({ reason, raisedAt }, at(checkIn), after);
    expect(result.kind === "resolved" ? result.state : result.kind).toBe(expected);
  });
});

describe("hazard HZ-125 a finish resolves an overdue alarm in its own words", () => {
  it.each([
    ["an overdue alarm, finished", "overdue", "resolved_by_finish"],
    ["a not-finished alarm, finished", "not_finished", "resolved_by_finish"],
    ["a duress alarm is never closed by a finish", "duress", "stays_open"],
  ] as const)("%s", (_label, reason, expected) => {
    const result = resolveOnCheckIn(
      { reason, raisedAt: at("23:15") },
      at("23:20"),
      { kind: "finished" },
      true,
    );
    expect(result.kind === "resolved" ? result.state : result.kind).toBe(expected);
  });
});

describe("hazard HZ-125 across the clock changes (UTC instants)", () => {
  it("measures a night across the end of British Summer Time as elapsed time", () => {
    // 25 October 2026: clocks go back at 02:00 BST (01:00 UTC); 22:00 BST is 21:00 UTC.
    const start = new Date("2026-10-24T21:00:00Z");
    const end = new Date("2026-10-25T07:00:00Z"); // 07:00 GMT, ten hours later
    expect(
      checkSession(
        { startedAt: start, plannedEndAt: end, intervalMinutes: 60 },
        {
          intervalMinMinutes: 15,
          intervalMaxMinutes: 120,
          sessionMaxHours: 10,
          clockDriftMinutes: 5,
        },
        start,
      ),
    ).toEqual([]);
    const due = nextCheckInDue(
      { startedAt: start, plannedEndAt: end, intervalMinutes: 60 },
      [new Date("2026-10-25T00:30:00Z")], // 01:30 BST, before the change
    );
    // One elapsed hour later: 01:30 GMT, the second 01:30 of the night.
    expect(due.dueAt).toEqual(new Date("2026-10-25T01:30:00Z"));
  });

  it("does the same across the start of British Summer Time", () => {
    // 28 March 2027: clocks go forward at 01:00 GMT.
    const start = new Date("2027-03-27T22:00:00Z");
    const due = nextCheckInDue(
      { startedAt: start, plannedEndAt: new Date("2027-03-28T06:00:00Z"), intervalMinutes: 120 },
      [new Date("2027-03-28T00:30:00Z")],
    );
    expect(due.dueAt).toEqual(new Date("2027-03-28T02:30:00Z"));
  });
});

describe("checkAcknowledge", () => {
  const open = { state: "open" as const, workerId: "worker" };
  it.each([
    ["the on-call person, safe", open, "on-call", "safe_confirmed", "Phoned, all well", [], false],
    ["the worker themself", open, "worker", "safe_confirmed", "Fine", ["own_alarm"], false],
    ["without a note", open, "on-call", "safe_confirmed", "  ", ["note_required"], false],
    ["help sent suggests an incident", open, "on-call", "help_sent", "Went round", [], true],
    [
      "emergency services suggests an incident",
      open,
      "on-call",
      "emergency_services_called",
      "999 called",
      [],
      true,
    ],
    [
      "already acknowledged",
      { ...open, state: "acknowledged" as const },
      "on-call",
      "other",
      "Duplicate",
      ["not_open"],
      true,
    ],
  ] as const)("%s", (_label, alarm, by, outcome, note, problems, incident) => {
    expect(checkAcknowledge(alarm, { by, outcome, note })).toEqual({
      problems,
      incidentSuggested: incident,
    });
  });
});

describe("hazard HZ-125 realertDue: an open alarm is never silent", () => {
  it.each([
    ["open, period not passed", "open", "23:15", "23:24", false],
    ["open, period passed", "open", "23:15", "23:25", true],
    ["open long after the chain ran out", "open", "23:15", "2026-11-03T03:00", true],
    ["acknowledged", "acknowledged", "23:15", "23:59", false],
    ["resolved late", "resolved_late_check_in", "23:15", "23:59", false],
  ] as const)("%s", (_label, state, last, now, expected) => {
    const nowAt = now.includes("T") ? new Date(`${now}:00Z`) : at(now);
    expect(realertDue({ state, lastAlertedAt: at(last) }, 10, nowAt)).toBe(expected);
  });
});

describe("checkRoute (H-539)", () => {
  const onCall: EscalationStep = {
    afterMinutes: 1,
    targetTenantUserId: "00000000-0000-4000-8000-000000000001",
    channels: ["push", "sms"],
  };
  const manager: EscalationStep = {
    afterMinutes: 10,
    targetRoleKey: "registered_manager",
    channels: ["push", "email"],
  };
  it.each([
    ["on-call then the Registered Manager", [onCall, manager], []],
    [
      "on-call role then the Registered Manager",
      [{ ...onCall, targetTenantUserId: undefined, targetRoleKey: "care_coordinator" }, manager],
      [],
    ],
    ["only one step", [onCall], ["too_few_steps"]],
    [
      "no Registered Manager",
      [onCall, { ...manager, targetRoleKey: "deputy_manager" }],
      ["no_registered_manager"],
    ],
    [
      "the manager first",
      [
        { ...manager, afterMinutes: 1 },
        { ...manager, afterMinutes: 5 },
      ],
      ["manager_first"],
    ],
    ["in-app only", [{ ...onCall, channels: ["in_app"] as const }, manager], ["in_app_only"]],
    ["steps out of order", [{ ...onCall, afterMinutes: 20 }, manager], ["chain"]],
  ] as const)("%s", (_label, steps, expected) => {
    expect(checkRoute(steps as readonly EscalationStep[]).problems).toEqual(expected);
  });
});

describe("words", () => {
  it("every state and reason has words (status never by colour alone)", () => {
    for (const s of LONE_WORKER_ALARM_STATES) expect(ALARM_STATE_WORDS[s]).toMatch(/^[A-Z]/);
    for (const r of LONE_WORKER_ALARM_REASONS) expect(ALARM_REASON_WORDS[r]).toMatch(/^[A-Z]/);
  });

  it.each([
    ["check_in", "check_in"],
    ["duress", "check_in"],
    ["help", "help"],
    ["finish", "finish"],
  ] as const)("the worker's own screen shows %s as %s", (kind, shown) => {
    expect(kindShownToWorker(kind)).toBe(shown);
  });
});

describe("the figures live in the rate table", () => {
  const rows = readRateTable();
  it.each(Object.entries(LONE_WORKER_RATE_KEYS))("%s has a current positive row", (_name, key) => {
    const row = rows.find((r) => r.key === key && r.validTo === null && r.nation === "all");
    expect(Number(row?.value)).toBeGreaterThan(0);
  });

  it("the shipped interval bounds and grace make sense together", () => {
    const value = (key: string) =>
      Number(rows.find((r) => r.key === key && r.validTo === null)?.value);
    expect(value(LONE_WORKER_RATE_KEYS.intervalMinMinutes)).toBeLessThan(
      value(LONE_WORKER_RATE_KEYS.intervalMaxMinutes),
    );
    expect(value(LONE_WORKER_RATE_KEYS.realertMinutes)).toBeGreaterThan(0);
  });
});
