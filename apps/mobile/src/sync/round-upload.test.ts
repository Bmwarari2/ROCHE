import { AcknowledgeHandover, TaskTransitionRequest } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import type { QueuedTaskMove } from "../care/round-actions";
import {
  isRoundWritableTable,
  mayResend,
  moveMade,
  overtakenMessage,
  type RoundMove,
  roundRefusalMessage,
  type TaskState,
  taskStateIn,
  taskStatePath,
  toRoundUpload,
} from "./round-upload";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const TASK = "0199d000-0000-7000-8000-0000000000a1";
const MOVE_ID = "0199d000-0000-7000-8000-000000000101";
const ACK_ID = "0199d000-0000-7000-8000-000000000201";
const HANDOVER = "0199d000-0000-7000-8000-000000000301";
const LOCATION = "0199d000-0000-7000-8000-000000000401";

const move: QueuedTaskMove = {
  id: MOVE_ID,
  to: "skipped",
  reason: "Asleep, will turn at 03:00",
  version: 3,
  by: "user-carer",
  at: "2026-10-11T02:05:00.000Z",
  tenantId: TENANT,
  personId: "person-ada",
  locationId: "loc-north",
  dueAt: "2026-10-11 02:00:00Z",
  title: "Reposition",
};

const taskPatch = (data: Record<string, unknown>) =>
  ({ op: "PATCH", table: "task", id: TASK, opData: data }) as const;

const ack = (data: Record<string, unknown> = {}, op = "PUT") =>
  ({
    op,
    table: "handover_acknowledgement",
    id: ACK_ID,
    opData: {
      tenant_id: TENANT,
      handover_id: HANDOVER,
      location_id: LOCATION,
      seen_token: "token-43",
      item_keys: "[]",
      ...data,
    },
  }) as const;

describe("a task's move to its own route", () => {
  it("sends the move with the version seen, keyed by the move's own id", () => {
    const request = toRoundUpload(
      taskPatch({ status: "skipped", queued_transition: JSON.stringify(move) }),
    );
    if (request.kind !== "request") throw new Error("expected a request");
    expect(request).toMatchObject({
      table: "task",
      recordId: MOVE_ID,
      tenantId: TENANT,
      personId: "person-ada",
      path: `/v1/tasks/${TASK}/transition`,
      body: { to: "skipped", reason: "Asleep, will turn at 03:00", version: 3 },
    });
    expect(TaskTransitionRequest.parse(request.body)).toEqual(request.body);
    expect(request.move?.taskId).toBe(TASK);
  });

  it("hazard HZ-017 keeps the move's device time on the phone: the API records the completion when it arrives", () => {
    const request = toRoundUpload(
      taskPatch({ status: "skipped", queued_transition: JSON.stringify(move) }),
    );
    if (request.kind !== "request") throw new Error("expected a request");
    expect(Object.keys(request.body).sort()).toEqual(["reason", "to", "version"]);
  });

  it("hazard HZ-006 sends a move put back on its task's row after the session that recorded it ended", () => {
    // `held-work.ts` inserts the task's row with the move when the session's end cleared it.
    const request = toRoundUpload({
      op: "PUT",
      table: "task",
      id: TASK,
      opData: {
        tenant_id: TENANT,
        person_id: "person-ada",
        status: "skipped",
        queued_transition: JSON.stringify(move),
      },
    });
    expect(request).toMatchObject({
      kind: "request",
      recordId: MOVE_ID,
      personId: "person-ada",
      path: `/v1/tasks/${TASK}/transition`,
      body: { to: "skipped", version: 3 },
    });
  });

  it("refuses, with a reason, a change to a task that is not a readable move", () => {
    for (const entry of [
      taskPatch({ status: "done" }),
      taskPatch({ queued_transition: "{not json" }),
      { ...taskPatch({ queued_transition: JSON.stringify(move) }), op: "DELETE" as const },
    ]) {
      const refusal = toRoundUpload(entry);
      expect(refusal).toMatchObject({ kind: "refused", code: "round_change_unreadable" });
    }
  });
});

describe("hazard HZ-018 an acknowledgement to its own route", () => {
  it("sends the device's id and the seen token worked out over the items shown", () => {
    const request = toRoundUpload(ack());
    if (request.kind !== "request") throw new Error("expected a request");
    expect(request).toMatchObject({
      recordId: ACK_ID,
      tenantId: TENANT,
      path: `/v1/locations/${LOCATION}/handovers/${HANDOVER}/acknowledgements`,
      body: { id: ACK_ID, seenToken: "token-43" },
      move: null,
    });
    expect(AcknowledgeHandover.parse(request.body)).toEqual(request.body);
  });

  it("refuses an acknowledgement changed on the device or missing what the route needs", () => {
    for (const entry of [ack({}, "PATCH"), ack({ seen_token: null }), ack({ location_id: "" })]) {
      expect(toRoundUpload(entry).kind).toBe("refused");
    }
  });
});

describe("what a carer is told", () => {
  it("only round and handover tables take this path", () => {
    expect(isRoundWritableTable("task")).toBe(true);
    expect(isRoundWritableTable("handover_acknowledgement")).toBe(true);
    expect(isRoundWritableTable("handover_note")).toBe(false);
    expect(isRoundWritableTable("care_note")).toBe(false);
  });

  it("words the two refusals a carer must act on, and keeps the API's reason otherwise", () => {
    expect(roundRefusalMessage("task", "version_conflict", "x")).toMatch(/Someone else changed/);
    expect(roundRefusalMessage("handover_acknowledgement", "handover_changed", "x")).toMatch(
      /Open it again/,
    );
    expect(roundRefusalMessage("task", "missing_permission", "Not yours")).toBe("Not yours");
  });

  it("words what happened to a task the move did not reach in time", () => {
    const state = (status: string): TaskState => ({
      status,
      version: 4,
      completedBy: "user-other",
      statusReason: null,
      completedAt: "2026-10-11T02:03:00.000Z",
    });
    expect(overtakenMessage(state("done"))).toMatch(
      /^This task was already marked done before your change reached Harbour, so your change was not recorded\./,
    );
    expect(overtakenMessage(state("skipped"))).toMatch(/^This task was already marked not done /);
    expect(overtakenMessage(state("cancelled"))).toMatch(/^This task was cancelled before /);
    expect(overtakenMessage(state("open"))).toMatch(/^This task changed before /);
    expect(overtakenMessage(null)).toMatch(/^This task changed before /);
  });
});

describe("hazard HZ-029 a move the API says the task changed for (#37 review round 1)", () => {
  const taken: RoundMove = { ...move, taskId: TASK };
  const state = (overrides: Partial<TaskState> = {}): TaskState => ({
    status: "skipped",
    version: 4,
    completedBy: "user-carer",
    statusReason: "Asleep, will turn at 03:00",
    completedAt: "2026-10-11T02:06:00.000Z",
    ...overrides,
  });

  it.each([
    ["this move, made at the next version", {}, {}, true],
    ["made by someone else", { completedBy: "user-other" }, {}, false],
    ["another status", { status: "done" }, {}, false],
    ["not done for another reason", { statusReason: "Out with family" }, {}, false],
    ["a later version (another move since)", { version: 5 }, {}, false],
    ["the same version (nothing made)", { version: 3 }, {}, false],
    ["a move kept without who made it", {}, { by: null }, false],
  ] as const)(
    "counts the move as made only when the task shows it: %s",
    (_label, now, mv, made) => {
      expect(moveMade(state(now), { ...taken, ...mv })).toBe(made);
    },
  );

  it("counts a task done at the next version by the carer as their move, with no reason to match", () => {
    const done: RoundMove = { ...taken, to: "done", reason: null };
    expect(moveMade(state({ status: "done", statusReason: null }), done)).toBe(true);
  });

  it.each([
    ["open at a later version", { status: "open", version: 4 }, true],
    ["in progress at a later version", { status: "in_progress", version: 5 }, true],
    ["open at the version seen", { status: "open", version: 3 }, false],
    ["done by someone else", { status: "done", completedBy: "user-other" }, false],
    ["not done", { status: "skipped" }, false],
    ["cancelled", { status: "cancelled", completedBy: null }, false],
  ] as const)("sends the move again only when nobody closed the task: %s", (_label, now, again) => {
    expect(mayResend(state(now), taken)).toBe(again);
  });

  it("reads the task from the API's list, and decides nothing on an answer it cannot read", () => {
    const item = {
      id: TASK,
      status: "done",
      version: 4,
      completedBy: "user-other",
      statusReason: null,
      completedAt: "2026-10-11T02:03:00.000Z",
    };
    expect(taskStateIn({ items: [{ id: "another" }, item] }, TASK)).toEqual({
      status: "done",
      version: 4,
      completedBy: "user-other",
      statusReason: null,
      completedAt: "2026-10-11T02:03:00.000Z",
    });
    expect(taskStateIn({ items: [{ ...item, id: "another" }] }, TASK)).toBeNull();
    expect(taskStateIn({ items: [{ ...item, version: "4" }] }, TASK)).toBe("unreadable");
    expect(taskStateIn({ items: [{ ...item, completedBy: undefined }] }, TASK)).toBe("unreadable");
    expect(taskStateIn({ items: "none" }, TASK)).toBe("unreadable");
    expect(taskStateIn("not a list", TASK)).toBe("unreadable");
    expect(taskStateIn(null, TASK)).toBe("unreadable");
  });

  it("asks for the task about its person, or at its home, within a second of its due time", () => {
    const window = "from=2026-10-11T01%3A59%3A59.000Z&to=2026-10-11T02%3A00%3A01.000Z";
    expect(taskStatePath(taken)).toBe(`/v1/tasks?status=any&personId=person-ada&${window}`);
    expect(taskStatePath({ ...taken, personId: null })).toBe(
      `/v1/tasks?status=any&locationId=loc-north&${window}`,
    );
    expect(taskStatePath({ ...taken, personId: null, locationId: null, dueAt: null })).toBe(
      "/v1/tasks?status=any",
    );
  });
});
