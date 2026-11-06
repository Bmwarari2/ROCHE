import { describe, expect, it } from "vitest";
import { emergencyRequest, screenSafePayload, toShiftUpload } from "../sync/shift-upload";
import {
  clockStatement,
  loneEmergencyStatement,
  loneEventStatement,
  loneStartStatement,
} from "./actions";
import { type ClockEventRow, clockState, clockView, type ShiftRow, shiftItems } from "./clock-view";
import {
  helpState,
  loneWorkerView,
  type Mine,
  nextDue,
  parseMine,
  queuedActions,
  refusedActions,
  screenKind,
} from "./lone-worker-view";

/**
 * The Shifts tab's logic (scheduling.md section 18; SCHED-002, SCHED-004, SCHED-012; HZ-010,
 * HZ-124, HZ-125), table-driven. Invented ids only.
 */

const TENANT = "0199d000-0000-7000-8000-0000000000a1";
const LOCATION = "0199d000-0000-7000-8000-000000000401";
const SHIFT = "0199d000-0000-7000-8000-000000000801";
const SESSION = "0199d000-0000-7000-8000-000000000601";
const EVENT = "0199d000-0000-7000-8000-000000000602";
const NOW = new Date("2026-10-11T07:30:00.000Z");

const shift = (overrides: Partial<ShiftRow> = {}): ShiftRow => ({
  id: SHIFT,
  location_id: LOCATION,
  label: "Early",
  kind: "work",
  starts_at: "2026-10-11T07:00:00.000Z",
  ends_at: "2026-10-11T15:00:00.000Z",
  break_minutes: 30,
  changed_after_publish_at: null,
  ...overrides,
});

const event = (kind: string, at: string, recorded = true): ClockEventRow => ({
  id: `e-${kind}-${at}`,
  kind,
  shift_id: SHIFT,
  location_id: LOCATION,
  device_time: at,
  recorded_at: recorded ? at : null,
});

describe("clock state comes from the member's own events, latest by the device's time (HZ-010)", () => {
  it.each([
    ["no events", [], "out"],
    ["clocked in", [event("in", "2026-10-11T07:02:00Z")], "in"],
    [
      "on a break",
      [event("in", "2026-10-11T07:02:00Z"), event("break_start", "2026-10-11T10:00:00Z")],
      "on_break",
    ],
    [
      "back from a break",
      [
        event("in", "2026-10-11T07:02:00Z"),
        event("break_start", "2026-10-11T10:00:00Z"),
        event("break_end", "2026-10-11T10:30:00Z"),
      ],
      "in",
    ],
    [
      "clocked out, events out of order",
      [event("out", "2026-10-11T15:01:00Z"), event("in", "2026-10-11T07:02:00Z")],
      "out",
    ],
  ] as const)("%s", (_case, events, state) => {
    expect(clockState(events)).toBe(state);
  });

  it("offers only what makes sense, and names the shift for a screen reader", () => {
    const out = clockView([shift()], [], NOW);
    expect(out.actions.map((a) => a.kind)).toEqual(["in"]);
    expect(out.actions[0]?.accessibilityLabel).toBe("Clock in, for Early");
    expect(out.locationId).toBe(LOCATION);
    expect(out.shiftId).toBe(SHIFT);
    const inn = clockView([shift()], [event("in", "2026-10-11T07:02:00Z", false)], NOW);
    expect(inn.actions.map((a) => a.kind)).toEqual(["break_start", "out"]);
    expect(inn.words).toBe("Clocked in at 08:02");
    expect(inn.waiting).toBe(1);
  });

  it("cannot tell where to clock in without a shift or a single location", () => {
    expect(clockView([], [], NOW).locationId).toBeNull();
    expect(clockView([], [], NOW, LOCATION).locationId).toBe(LOCATION);
  });

  it("lists shifts not yet ended, soonest first, saying in words when one changed", () => {
    const items = shiftItems(
      [
        shift({ id: "later", starts_at: "2026-10-12T07:00:00Z", ends_at: "2026-10-12T15:00:00Z" }),
        shift({ id: "ended", starts_at: "2026-10-10T07:00:00Z", ends_at: "2026-10-10T15:00:00Z" }),
        shift({ changed_after_publish_at: "2026-10-09T12:00:00Z", kind: "sleep_in" }),
      ],
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual([SHIFT, "later"]);
    expect(items[0]).toMatchObject({
      when: "11/10/2026, 08:00 to 16:00",
      kindWords: "Sleep-in",
      changed: "Changed after it was published",
      now: true,
    });
  });
});

describe("lone working on the phone (HZ-125)", () => {
  const mine = (overrides: Partial<NonNullable<Mine["session"]>> = {}): Mine => ({
    on: true,
    session: {
      id: SESSION,
      locationId: LOCATION,
      workKind: "domiciliary_visit",
      startedAt: "2026-10-11T09:00:00.000Z",
      plannedEndAt: "2026-10-11T13:00:00.000Z",
      intervalMinutes: 60,
      finishedAt: null,
      status: "ok",
      nextDueAt: "2026-10-11T10:00:00.000Z",
      overdueAlarmOpen: false,
      events: [],
      ...overrides,
    },
  });
  const queued = (kind: string, at = "2026-10-11T09:40:00.000Z") => ({
    id: EVENT,
    action: "event" as const,
    sessionId: SESSION,
    body: { id: EVENT, kind, deviceAt: at },
  });

  it.each([
    ["check_in", "check_in"],
    ["duress", "check_in"],
    ["help", "help"],
    ["finish", "finish"],
    ["anything else", "check_in"],
  ])("shows %s as %s", (kind, shown) => {
    expect(screenKind(kind)).toBe(shown);
  });

  it("shows a queued duress press exactly as a queued check-in", () => {
    const now = new Date("2026-10-11T09:45:00.000Z");
    const duress = loneWorkerView(mine(), [queued("duress")], now);
    const checkIn = loneWorkerView(mine(), [queued("check_in")], now);
    expect(duress).toEqual(checkIn);
    expect(JSON.stringify(duress)).not.toMatch(/duress/i);
    expect(duress.lines[0]?.words).toBe("Checked in at 10:40");
    expect(duress.lines[0]?.waiting).toBe(true);
  });

  it("shows a duress event from the server as a check-in, whatever the API sent", () => {
    const parsed = parseMine({
      on: true,
      session: {
        ...mine().session,
        events: [{ id: EVENT, kind: "duress", deviceAt: "2026-10-11T09:10:00Z", late: false }],
      },
    });
    expect(parsed?.session?.events[0]?.kind).toBe("check_in");
  });

  it.each([
    ["from the start", [], "2026-10-11T10:00:00.000Z"],
    [
      "from the latest sign",
      ["2026-10-11T09:40:00Z", "2026-10-11T09:20:00Z"],
      "2026-10-11T10:40:00.000Z",
    ],
    ["never past the planned end", ["2026-10-11T12:30:00Z"], "2026-10-11T13:00:00.000Z"],
  ])("works out the next check-in %s (section 17.3 rule 3)", (_case, signs, due) => {
    expect(nextDue("2026-10-11T09:00:00Z", "2026-10-11T13:00:00Z", 60, signs)?.toISOString()).toBe(
      due,
    );
  });

  it("counts a duress press as a check-in for the next due time, as the server does", () => {
    const now = new Date("2026-10-11T09:45:00.000Z");
    expect(loneWorkerView(mine(), [queued("duress")], now).due).toBe("Next check-in due at 11:40");
  });

  it("says when a check-in is overdue", () => {
    const view = loneWorkerView(mine(), [], new Date("2026-10-11T10:05:00.000Z"));
    expect(view).toMatchObject({
      overdue: true,
      due: "Check-in overdue since 11:00. Check in now.",
    });
  });

  it("knows a help press is waiting, so the screen can say it has not reached anyone", () => {
    expect(loneWorkerView(mine(), [queued("help")], NOW).helpWaiting).toBe(true);
  });

  it("keeps a session started offline until the server has it", () => {
    const start = {
      id: SESSION,
      action: "start" as const,
      sessionId: SESSION,
      body: {
        id: SESSION,
        startedAt: "2026-10-11T09:00:00.000Z",
        plannedEndAt: "2026-10-11T13:00:00.000Z",
        intervalMinutes: 60,
      },
    };
    const view = loneWorkerView(null, [start], new Date("2026-10-11T09:10:00.000Z"));
    expect(view).toMatchObject({ kind: "session", sessionId: SESSION, waiting: 1 });
  });

  it("says when lone working is off, and when there is no session", () => {
    expect(loneWorkerView({ on: false, session: null }, [], NOW).kind).toBe("off");
    expect(loneWorkerView({ on: true, session: null }, [], NOW).kind).toBe("none");
    expect(loneWorkerView(null, [], NOW).kind).toBe("none");
  });

  it("reads queued lone-working actions from the upload queue, leaving out anything else", () => {
    const row = (entry: unknown) => ({ data: JSON.stringify(entry) });
    const actions = queuedActions(
      [
        row({
          op: "PUT",
          type: "lone_worker_outbox",
          id: EVENT,
          data: {
            tenant_id: TENANT,
            action: "event",
            session_id: SESSION,
            body: JSON.stringify({ id: EVENT, kind: "check_in", deviceAt: "2026-10-11T09:40:00Z" }),
          },
        }),
        row({ op: "PUT", type: "care_note", id: "x", data: {} }),
        { data: "not json" },
        { data: null },
        // Another organisation's queued action never counts here.
        row({
          op: "PUT",
          type: "lone_worker_outbox",
          id: "other",
          data: { tenant_id: "another", action: "event", session_id: SESSION, body: "{}" },
        }),
      ],
      TENANT,
    );
    expect(actions).toEqual([
      {
        id: EVENT,
        action: "event",
        sessionId: SESSION,
        body: { id: EVENT, kind: "check_in", deviceAt: "2026-10-11T09:40:00Z" },
      },
    ]);
  });
});

describe("what the phone writes and sends (scheduling.md section 18)", () => {
  const at = new Date("2026-10-11T09:40:00.000Z");

  it("writes a duress press the same way as a check-in, with only its kind different", () => {
    const base = { eventId: EVENT, sessionId: SESSION, tenantId: TENANT, at };
    const duress = loneEventStatement({ ...base, kind: "duress" });
    const checkIn = loneEventStatement({ ...base, kind: "check_in" });
    expect(duress.sql).toBe(checkIn.sql);
    expect(duress.params.map((p) => (p ?? "").replace("duress", "check_in"))).toEqual(
      checkIn.params,
    );
  });

  it.each([
    [
      "a clock event",
      clockStatement({
        id: EVENT,
        tenantId: TENANT,
        workerId: "w",
        kind: "in",
        shiftId: SHIFT,
        locationId: LOCATION,
        at,
      }),
      "clock_event",
      "/v1/me/clock-events",
    ],
    [
      "a session start",
      loneStartStatement({
        sessionId: SESSION,
        tenantId: TENANT,
        locationId: LOCATION,
        workKind: "domiciliary_visit",
        at,
        hours: 4,
        intervalMinutes: 60,
      }),
      "lone_worker_outbox",
      "/v1/lone-worker/sessions",
    ],
    [
      "a check-in",
      loneEventStatement({
        eventId: EVENT,
        sessionId: SESSION,
        tenantId: TENANT,
        kind: "check_in",
        at,
      }),
      "lone_worker_outbox",
      `/v1/lone-worker/sessions/${SESSION}/events`,
    ],
  ] as const)("routes %s it wrote to its own API route", (_case, statement, table, path) => {
    const columns = /\(([^)]*)\) VALUES/
      .exec(statement.sql)?.[1]
      ?.split(",")
      .map((c) => c.trim());
    const values = [...statement.params];
    const opData: Record<string, unknown> = {};
    for (const [i, c] of (columns ?? []).entries()) {
      if (c !== "id") opData[c] = c === "recorded_at" ? null : (values[i] ?? null);
    }
    const upload = toShiftUpload({ op: "PUT", table, id: String(values[0]), opData });
    expect(upload).toMatchObject({ kind: "request", path, tenantId: TENANT });
  });

  it.each([
    ["an update", { op: "PATCH" as const }],
    ["no tenant", { opData: { tenant_id: null } }],
    ["an unknown clock kind", { opData: { kind: "lunch" } }],
    ["a device time that is not one", { opData: { device_time: "soon" } }],
    ["a shift id that is not a UUID", { opData: { shift_id: "s1" } }],
  ])("refuses, in words, a clock event with %s", (_case, change) => {
    const opData = {
      tenant_id: TENANT,
      kind: "in",
      location_id: LOCATION,
      shift_id: null,
      device_time: at.toISOString(),
      ...("opData" in change ? change.opData : {}),
    };
    const upload = toShiftUpload({
      op: "op" in change ? change.op : "PUT",
      table: "clock_event",
      id: EVENT,
      opData,
    });
    expect(upload).toMatchObject({ kind: "refused", code: "shift_change_unreadable" });
    expect(upload.kind === "refused" && upload.message).toMatch(/could not be sent/);
  });

  it("refuses a start whose body names another session", () => {
    const upload = toShiftUpload({
      op: "PUT",
      table: "lone_worker_outbox",
      id: SESSION,
      opData: {
        tenant_id: TENANT,
        action: "start",
        session_id: SESSION,
        body: JSON.stringify({ id: EVENT }),
      },
    });
    expect(upload.kind).toBe("refused");
  });

  it("keeps a refused duress press only as a check-in, and leaves everything else as it was", () => {
    const body = JSON.stringify({ id: EVENT, kind: "duress", deviceAt: at.toISOString() });
    const kept = screenSafePayload("lone_worker_outbox", { body, action: "event" });
    expect(JSON.stringify(kept)).not.toContain("duress");
    expect(JSON.parse(String(kept.body)).kind).toBe("check_in");
    const help = JSON.stringify({ id: EVENT, kind: "help", deviceAt: at.toISOString() });
    expect(screenSafePayload("lone_worker_outbox", { body: help })).toEqual({ body: help });
    expect(screenSafePayload("clock_event", { kind: "in" })).toEqual({ kind: "in" });
  });
});

describe("what lone working says when something did not reach Harbour (clinical review of slice 71)", () => {
  const mine: Mine = {
    on: true,
    session: {
      id: SESSION,
      locationId: LOCATION,
      workKind: "other",
      startedAt: "2026-10-11T09:00:00.000Z",
      plannedEndAt: "2026-10-11T13:00:00.000Z",
      intervalMinutes: 60,
      finishedAt: null,
      status: "ok",
      nextDueAt: "2026-10-11T10:20:00.000Z",
      overdueAlarmOpen: false,
      events: [],
    },
  };
  const now = new Date("2026-10-11T09:45:00.000Z");

  it.each([
    ["nothing", {}, true, false, "none"],
    ["help just pressed", {}, true, true, "sending"],
    ["help waiting offline", { helpWaiting: true }, false, true, "waiting"],
    ["help waiting online", { helpWaiting: true }, true, true, "sending"],
    ["help refused", { helpRefused: true, helpWaiting: true }, true, true, "refused"],
    ["help with Harbour", { helpReceived: true }, true, true, "received"],
  ] as const)("help line: %s", (_case, extra, connected, pressed, state) => {
    const view = { ...loneWorkerView(mine, [], now), ...extra };
    expect(helpState(view, connected, pressed)).toBe(state);
  });

  it("reads refused lone-working actions, a duress press only as a check-in", () => {
    const issue = (action: string, kind: string) => ({
      payload: JSON.stringify({
        action,
        session_id: SESSION,
        body: JSON.stringify({ id: EVENT, kind }),
      }),
    });
    expect(
      refusedActions([issue("event", "duress"), issue("start", ""), { payload: "x" }]),
    ).toEqual([
      { action: "event", sessionId: SESSION, kind: "check_in", eventId: EVENT },
      { action: "start", sessionId: SESSION, kind: "check_in", eventId: EVENT },
    ]);
  });

  it("says a refused help press reached nobody, and a refused start began nothing", () => {
    const refusals = [
      { action: "event" as const, sessionId: SESSION, kind: "help", eventId: null },
      { action: "start" as const, sessionId: SESSION, kind: "check_in", eventId: null },
    ];
    expect(loneWorkerView({ on: true, session: null }, [], now, refusals)).toMatchObject({
      kind: "none",
      helpRefused: true,
      startRefused: true,
    });
  });

  it("says a session known only on the phone is not monitored yet", () => {
    const start = {
      id: SESSION,
      action: "start" as const,
      sessionId: SESSION,
      body: {
        id: SESSION,
        startedAt: "2026-10-11T09:00:00.000Z",
        plannedEndAt: "2026-10-11T13:00:00.000Z",
        intervalMinutes: 60,
      },
    };
    expect(loneWorkerView(null, [start], now).unconfirmed).toBe(true);
    expect(loneWorkerView(mine, [], now).unconfirmed).toBe(false);
  });

  it("takes the server's next due time when nothing of the worker's waits (rule 6: safe confirmed)", () => {
    expect(loneWorkerView(mine, [], now).due).toBe("Next check-in due at 11:20");
  });

  it("keeps help offered while a finish waits to send", () => {
    const finish = {
      id: EVENT,
      action: "event" as const,
      sessionId: SESSION,
      body: { id: EVENT, kind: "finish", deviceAt: now.toISOString() },
    };
    expect(loneWorkerView(mine, [finish], now)).toMatchObject({ finished: true, due: null });
  });

  it.each([
    // The zone is said on a clock-change day, so the two 01:30s cannot be confused (HZ-009).
    // 25/10/2026: the clocks go back at 02:00 BST (01:00 UTC); 01:30 happens twice.
    [
      "autumn, the first 01:30 (BST)",
      "2026-10-24T23:30:00Z",
      60,
      "2026-10-25T00:30:00.000Z",
      "Next check-in due at 01:30 BST",
    ],
    [
      "autumn, the second 01:30 (GMT)",
      "2026-10-25T00:30:00Z",
      60,
      "2026-10-25T01:30:00.000Z",
      "Next check-in due at 01:30 GMT",
    ],
    // 29/03/2026: the clocks go forward at 01:00 GMT; 01:30 never happens.
    [
      "spring, across the gap",
      "2026-03-29T00:30:00Z",
      60,
      "2026-03-29T01:30:00.000Z",
      "Next check-in due at 02:30 BST",
    ],
  ])(
    "works out and says the next check-in across a clock change: %s",
    (_case, start, every, due, words) => {
      expect(nextDue(start, "2026-12-31T00:00:00Z", every, [])?.toISOString()).toBe(due);
      const session = {
        ...mine,
        session: {
          ...(mine.session as NonNullable<Mine["session"]>),
          startedAt: start,
          plannedEndAt: "2026-12-31T00:00:00Z",
          intervalMinutes: every,
          nextDueAt: null,
        },
      };
      expect(loneWorkerView(session, [], new Date(start)).due).toBe(words);
    },
  );

  it("refuses a queued action whose id is not its idempotency key (security review of slice 71)", () => {
    const body = JSON.stringify({ id: EVENT, kind: "check_in", deviceAt: now.toISOString() });
    const opData = { tenant_id: TENANT, action: "event", session_id: SESSION, body };
    expect(
      toShiftUpload({ op: "PUT", table: "lone_worker_outbox", id: SESSION, opData }).kind,
    ).toBe("refused");
    const start = {
      tenant_id: TENANT,
      action: "start",
      session_id: SESSION,
      body: JSON.stringify({ id: SESSION }),
    };
    expect(
      toShiftUpload({ op: "PUT", table: "lone_worker_outbox", id: EVENT, opData: start }).kind,
    ).toBe("refused");
  });
});

describe("help with no session on the phone (H-1317)", () => {
  const at = new Date("2026-10-11T09:40:00.000Z");

  it("queues help with no session for the emergency route", () => {
    const statement = loneEmergencyStatement({ eventId: EVENT, tenantId: TENANT, at });
    const columns = /\(([^)]*)\) VALUES/
      .exec(statement.sql)?.[1]
      ?.split(",")
      .map((c) => c.trim());
    const opData: Record<string, unknown> = {};
    for (const [i, c] of (columns ?? []).entries()) if (c !== "id") opData[c] = statement.params[i];
    expect(
      toShiftUpload({ op: "PUT", table: "lone_worker_outbox", id: EVENT, opData }),
    ).toMatchObject({
      kind: "request",
      path: "/v1/lone-worker/emergency",
      body: { id: EVENT, kind: "help", deviceAt: at.toISOString(), sessionId: null },
    });
  });

  it("never sends anything but help that way", () => {
    const body = JSON.stringify({ id: EVENT, kind: "duress", deviceAt: at.toISOString() });
    const opData = { tenant_id: TENANT, action: "emergency", session_id: EVENT, body };
    expect(toShiftUpload({ op: "PUT", table: "lone_worker_outbox", id: EVENT, opData }).kind).toBe(
      "refused",
    );
  });

  it.each([
    [404, "help", true],
    [403, "duress", true],
    [404, "check_in", false],
    [422, "duress", false],
  ])("sends a press refused with %s (%s) to the emergency route: %s", (status, kind, sent) => {
    const request = {
      kind: "request" as const,
      table: "lone_worker_outbox" as const,
      recordId: EVENT,
      tenantId: TENANT,
      path: `/v1/lone-worker/sessions/${SESSION}/events`,
      body: { id: EVENT, kind, deviceAt: at.toISOString() },
    };
    const next = emergencyRequest(request, status);
    expect(next !== null).toBe(sent);
    if (next) expect(next.body).toMatchObject({ sessionId: SESSION, kind });
  });

  it("says Harbour has a help press once it has left the phone unrefused", () => {
    const view = loneWorkerView({ on: true, session: null }, [], at, [], [EVENT]);
    expect(view.helpReceived).toBe(true);
    const queued = [
      {
        id: EVENT,
        action: "emergency" as const,
        sessionId: EVENT,
        body: { id: EVENT, kind: "help" },
      },
    ];
    expect(loneWorkerView({ on: true, session: null }, queued, at, [], [EVENT])).toMatchObject({
      helpReceived: false,
      helpWaiting: true,
    });
    const refused = [{ action: "event" as const, sessionId: EVENT, kind: "help", eventId: EVENT }];
    expect(loneWorkerView({ on: true, session: null }, [], at, refused, [EVENT])).toMatchObject({
      helpReceived: false,
      helpRefused: true,
    });
  });
});
