import type { LoneWorkerAlarmItem, LoneWorkerBoardItem } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  alarmChip,
  alarmsInOrder,
  dueWords,
  loneWorkerAccess,
  loneWorkerNavShown,
  newAnnouncements,
  ownChip,
  RETRY_WINDOW_MS,
  readAcknowledge,
  readRoute,
  readStart,
  routeRoleOptions,
  sessionChip,
  sessionsInOrder,
  targetValue,
  urgentAlarm,
  workerName,
} from "./lone-worker";

const t = createTranslator("en-GB");

const SESSION = "00000000-0000-4000-8000-0000000000";
const sid = (n: number) => `${SESSION}${String(n).padStart(2, "0")}`;

function alarm(
  n: number,
  reason: LoneWorkerAlarmItem["reason"],
  overrides: Partial<LoneWorkerAlarmItem> = {},
): LoneWorkerAlarmItem {
  return {
    id: `10000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    sessionId: sid(n),
    workerTenantUserId: `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    workerName: "Ada Example",
    locationId: "30000000-0000-4000-8000-000000000001",
    reason,
    reasonWords: reason,
    state: "open",
    stateWords: "Open",
    dueAt: null,
    raisedAt: `2026-10-31T10:${String(n).padStart(2, "0")}:00.000Z`,
    lastAlertedAt: "2026-10-31T10:00:00.000Z",
    alertCount: 1,
    lastCheckInAt: null,
    lastCheckInLate: false,
    resolvedAt: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    outcome: null,
    note: null,
    incidentId: null,
    location: null,
    version: 1,
    ...overrides,
  };
}

function session(
  n: number,
  status: LoneWorkerBoardItem["status"],
  nextDueAt: string | null = null,
): LoneWorkerBoardItem {
  return {
    sessionId: sid(n),
    workerTenantUserId: `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    workerName: "Ada Example",
    locationId: "30000000-0000-4000-8000-000000000001",
    workKind: "night_shift",
    startedAt: "2026-10-31T08:00:00.000Z",
    plannedEndAt: "2026-10-31T18:00:00.000Z",
    intervalMinutes: 30,
    status,
    statusWords: status,
    nextDueAt,
    lastCheckInAt: null,
    lastCheckInLate: false,
    openAlarmIds: [],
  };
}

function form(entries: Record<string, string | readonly string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const v of typeof value === "string" ? [value] : value) data.append(key, v);
  }
  return data;
}

describe("hazard HZ-125 the monitor board shows duress first (slice 61)", () => {
  it("orders open alarms duress, help, overdue, not finished, then the longest waiting", () => {
    const ordered = alarmsInOrder([
      alarm(1, "overdue"),
      alarm(2, "not_finished"),
      alarm(3, "help"),
      alarm(4, "duress"),
      alarm(5, "overdue", { raisedAt: "2026-10-31T09:00:00.000Z" }),
      alarm(6, "duress", { state: "acknowledged" }),
    ]);
    expect(ordered.map((a) => [a.reason, a.state])).toEqual([
      ["duress", "open"],
      ["help", "open"],
      ["overdue", "open"],
      ["overdue", "open"],
      ["not_finished", "open"],
      ["duress", "acknowledged"],
    ]);
    // Of two overdue alarms, the one raised first comes first.
    expect(ordered[2]?.sessionId).toBe(sid(5));
  });

  it("puts a session with a duress alarm above one overdue, whatever its own status", () => {
    const sessions = [
      session(1, "alarm"),
      session(2, "ok"),
      session(3, "due"),
      session(4, "finished"),
    ];
    const ordered = sessionsInOrder(sessions, [alarm(1, "overdue"), alarm(2, "duress")]);
    expect(ordered.map((s) => s.sessionId)).toEqual([sid(2), sid(1), sid(3), sid(4)]);
  });

  it("orders sessions without alarms by status, then the earliest check-in due", () => {
    const ordered = sessionsInOrder(
      [
        session(1, "ok", "2026-10-31T12:00:00.000Z"),
        session(2, "ok", "2026-10-31T11:00:00.000Z"),
        session(3, "due", "2026-10-31T13:00:00.000Z"),
        session(4, "ok", null),
      ],
      [],
    );
    expect(ordered.map((s) => s.sessionId)).toEqual([sid(3), sid(2), sid(1), sid(4)]);
  });

  it("puts the longest-waiting first among sessions with the same kind of alarm", () => {
    const ordered = sessionsInOrder(
      [session(1, "ok"), session(2, "ok")],
      [
        alarm(1, "help", { raisedAt: "2026-10-31T10:30:00.000Z" }),
        alarm(2, "help", { raisedAt: "2026-10-31T10:10:00.000Z" }),
      ],
    );
    expect(ordered.map((s) => s.sessionId)).toEqual([sid(2), sid(1)]);
  });

  it("announces only alarms new since the last read, never on arrival", () => {
    const a = { key: "a", words: "A", urgent: true };
    const b = { key: "b", words: "B", urgent: false };
    expect(newAnnouncements(null, [a, b])).toEqual([]);
    expect(newAnnouncements(new Set(["a"]), [a, b])).toEqual([b]);
    expect(newAnnouncements(new Set(["a", "b"]), [a])).toEqual([]);
  });

  it("ignores an acknowledged alarm when ordering sessions", () => {
    const ordered = sessionsInOrder(
      [session(1, "ok"), session(2, "due")],
      [alarm(1, "duress", { state: "acknowledged" })],
    );
    expect(ordered.map((s) => s.sessionId)).toEqual([sid(2), sid(1)]);
  });

  it.each([
    ["alarm", undefined, "overdue", "alarm"],
    ["due", undefined, "due", "due"],
    ["ok", undefined, "done", "ok"],
    ["finished", undefined, "notApplicable", "finished"],
    ["ok", "duress", "overdue", "duress"],
  ] as const)("shows a %s session with alarm %s as %s, in words", (status, reason, chip, label) => {
    const view = sessionChip(session(1, status), reason ? alarm(1, reason) : undefined);
    expect(view).toEqual({ status: chip, label });
  });

  it("shows an open alarm by its reason and a closed one by its state, in words", () => {
    expect(alarmChip(alarm(1, "duress"))).toEqual({ status: "overdue", label: "duress" });
    expect(
      alarmChip(alarm(1, "duress", { state: "acknowledged", stateWords: "Acknowledged" })),
    ).toEqual({
      status: "done",
      label: "Acknowledged",
    });
  });

  it.each([
    ["duress", "open", true],
    ["help", "open", true],
    ["overdue", "open", false],
    ["duress", "acknowledged", false],
  ] as const)("treats an alarm for %s, %s, as urgent: %s", (reason, state, urgent) => {
    expect(urgentAlarm({ reason, state })).toBe(urgent);
  });

  it("never shows an id for a worker whose name is not held", () => {
    expect(workerName({ workerName: null }, t)).toBe("Name not held");
  });

  it("tells a monitor to call 999 for duress and help, never to call the worker openly for duress", () => {
    expect(t("scheduling.loneWorker.board.urgent", { reason: "duress" })).toMatch(/999/);
    expect(t("scheduling.loneWorker.board.urgent", { reason: "duress" })).toMatch(
      /gives this away/,
    );
    expect(t("scheduling.loneWorker.board.urgent", { reason: "help" })).toMatch(/999/);
  });
});

describe("hazard HZ-125 the worker's own screen (slice 61)", () => {
  it("never names duress on the worker's own screen", () => {
    for (const kind of ["check_in", "help", "finish", "duress"]) {
      expect(
        t("scheduling.loneWorker.mine.eventLine", { kind, time: "10:00", late: "no" }),
      ).not.toMatch(/duress/i);
    }
  });

  it.each([
    ["ok", false, "done", "Checked in"],
    ["due", false, "due", "Check-in due"],
    ["alarm", true, "overdue", "Check-in overdue"],
    ["ok", true, "overdue", "Check-in overdue"],
    ["finished", false, "notApplicable", "Finished"],
  ] as const)("shows %s (alarm open %s) as %s %s", (status, open, chip, label) => {
    const now = new Date("2026-10-31T10:00:00.000Z");
    const view = ownChip(
      { status, overdueAlarmOpen: open, plannedEndAt: "2026-10-31T18:00:00.000Z" },
      now,
      t,
    );
    expect(view).toEqual({ status: chip, label });
  });

  it("says to finish or check in once past the planned finish (a not-finished alarm)", () => {
    const now = new Date("2026-10-31T18:05:00.000Z");
    const view = ownChip(
      { status: "alarm", overdueAlarmOpen: true, plannedEndAt: "2026-10-31T18:00:00.000Z" },
      now,
      t,
    );
    expect(view).toEqual({
      status: "overdue",
      label: "Past your planned finish: finish or check in",
    });
  });

  it("keeps a press's id only for a retry soon after", () => {
    expect(RETRY_WINDOW_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(RETRY_WINDOW_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("tells the worker a failed help press may not have been sent, and to call 999", () => {
    expect(t("scheduling.loneWorker.mine.helpNotSent")).toMatch(/may not have been sent/);
    expect(t("scheduling.loneWorker.mine.helpNotSent")).toMatch(/call 999/);
  });

  it("says when the next check-in is due, and when it is already due", () => {
    const now = new Date("2026-10-31T10:00:00.000Z");
    expect(dueWords("2026-10-31T10:30:00.000Z", now, t)).toBe("Next check-in due by 10:30");
    expect(dueWords("2026-10-31T09:30:00.000Z", now, t)).toBe("Check in now: it was due at 09:30");
    expect(dueWords(null, now, t)).toBeNull();
  });

  it("tells the worker to call 999 when lone working is off or overdue", () => {
    expect(t("scheduling.loneWorker.off.body")).toMatch(/call 999/);
    expect(t("scheduling.loneWorker.mine.overdueBody")).toMatch(/call 999/);
    expect(t("scheduling.loneWorker.mine.helpHint")).toMatch(/call 999/);
  });

  it.each([
    [{ locationId: "a", workKind: "night_shift", hours: "8", intervalMinutes: "30" }, 480, 30],
    [
      { locationId: "a", workKind: "other", hours: "1", minutes: "30", intervalMinutes: "15" },
      90,
      15,
    ],
    [
      { locationId: "a", workKind: "domiciliary_visit", minutes: "45", intervalMinutes: "20" },
      45,
      20,
    ],
  ])("reads a start form %#", (entries, length, interval) => {
    const read = readStart(form(entries), t);
    expect(read).toEqual({
      ok: true,
      input: {
        locationId: "a",
        workKind: entries.workKind,
        lengthMinutes: length,
        intervalMinutes: interval,
      },
    });
  });

  it.each([
    [{ workKind: "night_shift", hours: "8", intervalMinutes: "30" }, ["locationId"]],
    [{ locationId: "a", hours: "8", intervalMinutes: "30" }, ["workKind"]],
    [{ locationId: "a", workKind: "duress", hours: "8", intervalMinutes: "30" }, ["workKind"]],
    [{ locationId: "a", workKind: "other", hours: "0", intervalMinutes: "30" }, ["hours"]],
    [
      { locationId: "a", workKind: "other", hours: "1", minutes: "75", intervalMinutes: "30" },
      ["minutes"],
    ],
    [{ locationId: "a", workKind: "other", hours: "1", intervalMinutes: "" }, ["intervalMinutes"]],
    [
      { locationId: "a", workKind: "other", hours: "1", intervalMinutes: "1.5" },
      ["intervalMinutes"],
    ],
    [{}, ["locationId", "workKind", "hours", "intervalMinutes"]],
  ])("refuses a start form %# at its fields", (entries, fields) => {
    const read = readStart(form(entries), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems.map((p) => p.field)).toEqual(fields);
  });
});

describe("hazard HZ-125 acknowledging needs an outcome and a note (slice 61)", () => {
  it("reads an acknowledgement", () => {
    expect(readAcknowledge(form({ outcome: "help_sent", note: " Rang the worker " }), t)).toEqual({
      ok: true,
      outcome: "help_sent",
      note: "Rang the worker",
    });
  });

  it.each([
    [{ note: "Rang" }, ["outcome"]],
    [{ outcome: "closed", note: "Rang" }, ["outcome"]],
    [{ outcome: "safe_confirmed", note: "  " }, ["note"]],
    [{ outcome: "safe_confirmed", note: "x".repeat(2001) }, ["note"]],
  ])("refuses %#", (entries, fields) => {
    const read = readAcknowledge(form(entries), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems.map((p) => p.field)).toEqual(fields);
  });

  it("offers every outcome in words", () => {
    for (const outcome of ["safe_confirmed", "help_sent", "emergency_services_called", "other"]) {
      expect(t("scheduling.loneWorker.outcome", { outcome })).not.toBe(outcome);
    }
  });
});

describe("hazard HZ-125 the on-call route (H-539, slice 61)", () => {
  const good = {
    "step-1-minutes": "1",
    "step-1-target": "role:team_leader",
    "step-1-channel": ["push", "sms"],
    "step-2-minutes": "15",
    "step-2-target": "role:registered_manager",
    "step-2-channel": ["email"],
  };

  it("reads a valid route", () => {
    expect(readRoute(form(good), 2, t)).toEqual({
      ok: true,
      steps: [
        { afterMinutes: 1, targetRoleKey: "team_leader", channels: ["push", "sms"] },
        { afterMinutes: 15, targetRoleKey: "registered_manager", channels: ["email"] },
      ],
    });
  });

  it("reads a named person", () => {
    const id = "20000000-0000-4000-8000-000000000009";
    const read = readRoute(form({ ...good, "step-1-target": `person:${id}` }), 2, t);
    expect(read.ok && read.steps[0]).toEqual({
      afterMinutes: 1,
      targetTenantUserId: id,
      channels: ["push", "sms"],
    });
  });

  it.each([
    ["one step only", { ...good }, 1, ["step-1-target"]],
    [
      "the manager first",
      { ...good, "step-1-target": "role:registered_manager", "step-2-target": "role:team_leader" },
      2,
      ["step-1-target", "step-2-target"],
    ],
    ["no manager later", { ...good, "step-2-target": "role:deputy_manager" }, 2, ["step-2-target"]],
    ["in Harbour only", { ...good, "step-2-channel": ["in_app"] }, 2, ["step-2-channel"]],
    ["no channel", { ...good, "step-2-channel": [] }, 2, ["step-2-channel"]],
    ["no target", { ...good, "step-1-target": "" }, 2, ["step-1-target"]],
    ["minutes out of order", { ...good, "step-2-minutes": "1" }, 2, ["step-2-minutes"]],
    ["zero minutes", { ...good, "step-1-minutes": "0" }, 2, ["step-1-minutes"]],
    ["too many minutes", { ...good, "step-2-minutes": "1441" }, 2, ["step-2-minutes"]],
  ] as const)("refuses %s", (_, entries, count, fields) => {
    const read = readRoute(form(entries), count, t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems.map((p) => p.field)).toEqual(fields);
  });

  it("offers only the shipped staff roles that can see and acknowledge alarms", () => {
    const keys = routeRoleOptions().map((r) => r.key);
    expect(keys).toEqual(
      expect.arrayContaining(["registered_manager", "deputy_manager", "team_leader", "owner"]),
    );
    expect(keys).not.toContain("care_worker");
    expect(keys).not.toContain("family_representative");
  });

  it("keeps a saved step's target as its form value", () => {
    expect(targetValue({ targetRoleKey: "owner" })).toBe("role:owner");
    expect(targetValue({ targetRoleKey: "owner", targetTenantUserId: "x" })).toBe("person:x");
    expect(targetValue({})).toBe("");
  });
});

describe("lone working in the navigation", () => {
  it.each([
    [["scheduling.lone_worker.check_in"], true],
    [["scheduling.lone_worker.monitor"], true],
    [["scheduling.lone_worker.manage"], true],
    [["care.note.read"], false],
  ])("shows it for %j: %s", (permissions, shown) => {
    expect(loneWorkerNavShown(permissions)).toBe(shown);
  });

  it("reads each access separately", () => {
    expect(loneWorkerAccess(["scheduling.lone_worker.monitor"])).toEqual({
      checkIn: false,
      monitor: true,
      manage: false,
    });
  });
});
