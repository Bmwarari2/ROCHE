import { describe, expect, it } from "vitest";
import { DEMO_TENANT_ID } from "../demo/demo-data";
import { all, openLocalDatabase } from "../test-support/local-db";
import { clockStatement, loneEventStatement, loneStartStatement } from "./actions";
import { type ClockEventRow, clockView, type ShiftRow } from "./clock-view";
import { loneWorkerView, queuedActions } from "./lone-worker-view";
import { DEMO_QUEUED_LONE_WORKER_SQL, MY_CLOCK_EVENTS_SQL, MY_SHIFTS_SQL } from "./queries";

/**
 * The Shifts tab's SQL against the phone's own schema, with the demo seed (scheduling.md section
 * 18). Invented ids only.
 */

const SEEDED = new Date("2026-10-11T09:00:00.000Z");
const WORKER = "00000000-0000-4000-8000-00000000d202";
const SESSION = "0199d000-0000-7000-8000-000000000601";

describe("the Shifts tab's SQL on the phone's schema", () => {
  it("reads the demo shifts, writes a clock-in and reads it back as clocked in", async () => {
    const db = await openLocalDatabase({ seedDemo: SEEDED });
    const shifts = all<ShiftRow>(db, MY_SHIFTS_SQL, [DEMO_TENANT_ID]);
    expect(shifts).toHaveLength(2);
    const before = clockView(shifts, [], SEEDED);
    expect(before.shift?.title).toBe("Day shift");
    const write = clockStatement({
      id: "0199d000-0000-7000-8000-000000000501",
      tenantId: DEMO_TENANT_ID,
      workerId: WORKER,
      kind: "in",
      shiftId: before.shiftId,
      locationId: before.locationId ?? "",
      at: SEEDED,
    });
    db.prepare(write.sql).run(...write.params);
    const events = all<ClockEventRow>(db, MY_CLOCK_EVENTS_SQL, [DEMO_TENANT_ID, WORKER]);
    const after = clockView(shifts, events, SEEDED);
    expect(after.state).toBe("in");
    expect(after.waiting).toBe(1);
    // Another member's events are never read as the member's own.
    expect(all(db, MY_CLOCK_EVENTS_SQL, [DEMO_TENANT_ID, "someone-else"])).toEqual([]);
  });

  it("reads the demo's queued lone-working actions in the upload queue's shape", async () => {
    const db = await openLocalDatabase({ seedDemo: SEEDED });
    const start = loneStartStatement({
      sessionId: SESSION,
      tenantId: DEMO_TENANT_ID,
      locationId: "00000000-0000-4000-8000-00000000d101",
      workKind: "other",
      at: SEEDED,
      hours: 4,
      intervalMinutes: 60,
    });
    const duress = loneEventStatement({
      eventId: "0199d000-0000-7000-8000-000000000602",
      sessionId: SESSION,
      tenantId: DEMO_TENANT_ID,
      kind: "duress",
      at: new Date(SEEDED.getTime() + 600_000),
    });
    for (const w of [start, duress]) db.prepare(w.sql).run(...w.params);
    const queued = queuedActions(all<{ data: string }>(db, DEMO_QUEUED_LONE_WORKER_SQL, []));
    expect(queued.map((q) => q.action)).toEqual(["start", "event"]);
    const view = loneWorkerView(null, queued, SEEDED);
    expect(view).toMatchObject({ kind: "session", sessionId: SESSION, waiting: 2 });
    expect(view.lines.map((l) => l.words)).toEqual(["Checked in at 10:10"]);
  });
});
