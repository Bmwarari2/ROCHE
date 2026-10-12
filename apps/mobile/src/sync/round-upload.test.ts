import { AcknowledgeHandover, TaskTransitionRequest } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import type { QueuedTaskMove } from "../care/round-actions";
import {
  isRoundWritableTable,
  moveAlreadyMade,
  moveCheckPath,
  roundRefusalMessage,
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

  it("refuses, with a reason, a change to a task that is not a readable move", () => {
    for (const entry of [
      taskPatch({ status: "done" }),
      taskPatch({ queued_transition: "{not json" }),
      { ...taskPatch({ queued_transition: JSON.stringify(move) }), op: "PUT" as const },
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

describe("what a carer is told, and a lost response", () => {
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

  it("hazard HZ-029 counts a 409 as sent only when the list shows the carer's own move made", () => {
    const taken = { ...move, taskId: TASK };
    const list = (item: Record<string, unknown>) => ({
      items: [{ id: TASK, status: "skipped", completedBy: "user-carer", ...item }],
    });
    expect(moveAlreadyMade(list({}), taken)).toBe(true);
    expect(moveAlreadyMade(list({ completedBy: "user-other" }), taken)).toBe(false);
    expect(moveAlreadyMade(list({ status: "done" }), taken)).toBe(false);
    expect(moveAlreadyMade(list({ id: "another" }), taken)).toBe(false);
    expect(moveAlreadyMade(list({}), { ...taken, by: null })).toBe(false);
    expect(moveAlreadyMade("not a list", taken)).toBe(false);
  });

  it("finds the task in the list by the second around its due time", () => {
    expect(moveCheckPath({ ...move, taskId: TASK })).toBe(
      "/v1/tasks?status=closed&from=2026-10-11T01%3A59%3A59.000Z&to=2026-10-11T02%3A00%3A01.000Z",
    );
    expect(moveCheckPath({ ...move, dueAt: null, taskId: TASK })).toBeNull();
  });
});
