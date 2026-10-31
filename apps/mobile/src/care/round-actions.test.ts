import { createHash } from "node:crypto";
import { TaskTransitionRequest } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import type { WriteScope } from "../sync/write-scope";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";
import type { SqlValue } from "./entries";
import {
  acknowledgementInsert,
  checkTaskMove,
  type MoveContext,
  parseQueuedMove,
  seenToken,
  TASK_REASON_MAX,
  TaskMoveNotWritten,
  type TaskToMove,
  type WriteDb,
  writeAcknowledgement,
  writeTaskMove,
} from "./round-actions";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const TASK = "0199d000-0000-7000-8000-0000000000a1";
const NOW = new Date("2026-10-11T02:05:00.000Z");
const ids = () => {
  let n = 0;
  return () => {
    n += 1;
    return `0199d000-0000-7000-8000-00000000010${n}`;
  };
};

const task = (overrides: Partial<TaskToMove> = {}): TaskToMove => ({
  id: TASK,
  tenant_id: TENANT,
  person_id: "person-ada",
  location_id: "loc-north",
  title: "Reposition",
  status: "open",
  due_at: "2026-10-11 02:00:00Z",
  evidence_required: 0,
  required_permission: "care.note.write",
  assignee_tenant_user_id: null,
  version: 3,
  queued_transition: null,
  ...overrides,
});

/** A care worker who records about the people assigned to them (Ada), living at North. */
const carerScope: WriteScope = {
  locationIds: [],
  assigned: true,
  personIds: ["person-ada"],
  peopleLocationIds: [],
};
const context: MoveContext = {
  userId: "user-carer",
  scope: carerScope,
  personLocationId: "loc-north",
  newId: ids(),
};

/** The app's write path on a real SQLite engine: a transaction that rolls back on a throw. */
function writeDb(db: SqliteDatabase): WriteDb {
  return {
    async writeTransaction(fn) {
      db.exec("BEGIN");
      try {
        const result = await fn({
          execute: async (sql: string, params: SqlValue[] = []) => db.prepare(sql).run(...params),
          getOptional: async <R>(sql: string, params: SqlValue[] = []) =>
            (db.prepare(sql).all(...params)[0] as R | undefined) ?? null,
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function withTask(row: Partial<TaskToMove> = {}) {
  const db = await openLocalDatabase();
  const t = task(row);
  db.prepare(
    `INSERT INTO task (id, tenant_id, person_id, title, status, due_at, evidence_required, version,
      queued_transition) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.tenant_id,
    t.person_id,
    t.title,
    t.status,
    t.due_at,
    t.evidence_required,
    t.version,
    t.queued_transition,
  );
  return db;
}

describe("moving a task on the phone (the API's own transition rules)", () => {
  it.each([
    ["done", "open", 0, "", null],
    ["done", "in_progress", 0, "", null],
    ["skipped", "open", 0, "Asleep, will turn at 03:00", null],
    ["skipped", "open", 0, "", "mobile.round.reasonRequired"],
    ["skipped", "open", 0, "  no ", "mobile.round.reasonRequired"],
    ["skipped", "open", 0, "x".repeat(TASK_REASON_MAX + 1), "mobile.round.reasonTooLong"],
    // A task that needs evidence is done by recording the entry it asks for, never by a tap.
    ["done", "open", 1, "", "mobile.round.evidenceRequired"],
    ["skipped", "open", 1, "Refused the turn", null],
    ["done", "done", 0, "", "mobile.round.notOpen"],
    ["skipped", "cancelled", 0, "Asleep", "mobile.round.notOpen"],
  ] as const)("%s from %s (evidence %s, reason %j): %s", (to, status, evidence, reason, error) => {
    const check = checkTaskMove(
      task({ status, evidence_required: evidence }),
      { to, reason },
      context,
      NOW,
    );
    expect(check.ok ? null : check.error.key).toBe(error);
  });

  it.each([
    ["a person the carer may record about", {}, {}, null],
    ["no write scope known yet", {}, { scope: null }, "mobile.round.scopeUnknown"],
    ["no member known yet", {}, { userId: null }, "mobile.round.userUnknown"],
    [
      "a home the carer may only read",
      { person_id: "person-ben" },
      { scope: { ...carerScope, personIds: ["person-ada"] } },
      "mobile.round.notYours",
    ],
    [
      "a task given to the carer, about nobody",
      {
        person_id: null,
        required_permission: "platform.task.manage",
        assignee_tenant_user_id: "user-carer",
      },
      {},
      null,
    ],
    [
      "a task about nobody given to someone else",
      { person_id: null, required_permission: "care.note.write" },
      {},
      "mobile.round.notYours",
    ],
    [
      "a task naming another permission",
      { required_permission: "medicines.emar.administer" },
      {},
      "mobile.round.notYours",
    ],
    [
      "a task given to the carer while the scope is unknown",
      { assignee_tenant_user_id: "user-carer" },
      { scope: null },
      "mobile.round.scopeUnknown",
    ],
    [
      "a person whose row is not on the phone yet (no home known; #36 review round 2)",
      {},
      { personLocationId: null, scope: { ...carerScope, personIds: null } },
      "mobile.round.personUnknown",
    ],
    [
      // Refused whoever it is given to: never marked without the person's header (#123 clinical
      // review, M2).
      "a task given to the carer about a person whose row is not here yet",
      { assignee_tenant_user_id: "user-carer" },
      { personLocationId: null },
      "mobile.round.personUnknown",
    ],
    [
      "a medicines task, before eMAR (#123 clinical review, L10)",
      { assignee_tenant_user_id: "user-carer", kind: "medicines.administration" },
      {},
      "mobile.round.medicinesOnWeb",
    ],
  ] as const)(
    "hazard HZ-006 moves a task only where the server would take it: %s (#36 review round 1, M1)",
    (_name, row, ctx, error) => {
      const check = checkTaskMove(
        task(row as Partial<TaskToMove>),
        { to: "done", reason: "" },
        { ...context, ...(ctx as Partial<MoveContext>) },
        NOW,
      );
      expect(check.ok ? null : check.error.key).toBe(error);
    },
  );

  it("hazard HZ-029 refuses a second move while one is waiting to upload", () => {
    const check = checkTaskMove(
      task({ queued_transition: '{"id":"x"}' }),
      { to: "done", reason: "" },
      context,
      NOW,
    );
    expect(check.ok ? null : check.error.key).toBe("mobile.round.alreadyQueued");
  });

  it("keeps the version seen, who and when, and the reason only for a task not done", () => {
    const check = checkTaskMove(task(), { to: "skipped", reason: " Asleep " }, context, NOW);
    if (!check.ok) throw new Error("expected a move");
    expect(check.move).toMatchObject({
      to: "skipped",
      reason: "Asleep",
      version: 3,
      by: "user-carer",
      at: NOW.toISOString(),
      tenantId: TENANT,
      personId: "person-ada",
      locationId: "loc-north",
      dueAt: "2026-10-11 02:00:00Z",
      title: "Reposition",
    });
    expect(parseQueuedMove(JSON.stringify(check.move))).toEqual(check.move);
    const done = checkTaskMove(task(), { to: "done", reason: "ignored" }, context, NOW);
    expect(done.ok && done.move.reason).toBeNull();
  });

  it("keeps the reason within the API's own limit", () => {
    const at = (length: number) =>
      TaskTransitionRequest.safeParse({ to: "skipped", reason: "x".repeat(length), version: 1 })
        .success;
    expect(at(TASK_REASON_MAX)).toBe(true);
    expect(at(TASK_REASON_MAX + 1)).toBe(false);
  });

  it("reads back no move from a missing or malformed value", () => {
    expect(parseQueuedMove(null)).toBeNull();
    expect(parseQueuedMove("not json")).toBeNull();
    expect(parseQueuedMove(JSON.stringify({ id: "a", tenantId: TENANT, at: "x" }))).toBeNull();
    expect(
      parseQueuedMove(
        JSON.stringify({ id: "a", tenantId: TENANT, at: "x", to: "cancelled", version: 1 }),
      ),
    ).toBeNull();
  });

  it("hazard HZ-029 writes the move on the row the carer saw, and nothing on a row that has changed", async () => {
    const db = await withTask();
    const check = checkTaskMove(task(), { to: "done", reason: "" }, context, NOW);
    if (!check.ok) throw new Error("expected a move");
    await writeTaskMove(writeDb(db), check);
    const [row] = all<{ status: string; queued_transition: string }>(
      db,
      "SELECT status, queued_transition FROM task WHERE id = ?",
      [TASK],
    );
    expect(row?.status).toBe("done");
    expect(parseQueuedMove(row?.queued_transition)?.id).toBe(check.move.id);

    // The server's copy moved on (a new version) before the carer's tap was written.
    const stale = await withTask({ version: 4 });
    await expect(writeTaskMove(writeDb(stale), check)).rejects.toBeInstanceOf(TaskMoveNotWritten);
    expect(all(stale, "SELECT status FROM task WHERE id = ?", [TASK])).toEqual([
      { status: "open" },
    ]);
  });
});

describe("hazard HZ-018 acknowledging a handover on the phone", () => {
  /** The API's own token (apps/api/src/routes/handovers.ts). */
  const apiToken = (handoverId: string, keys: string[]) =>
    createHash("sha256")
      .update([handoverId, ...keys].join("\n"))
      .digest("base64url")
      .slice(0, 43);
  const sha256Base64 = async (text: string) => createHash("sha256").update(text).digest("base64");

  it("works out the seen token exactly as the API does", async () => {
    for (const keys of [
      [],
      ["fall:observation:a"],
      ["fall:observation:a", "news2:observation:b+/"],
    ]) {
      expect(await seenToken("handover-1", keys, sha256Base64)).toBe(apiToken("handover-1", keys));
    }
  });

  it("hazard HZ-029 acknowledges the items shown in their compiled order, once while it waits to upload", async () => {
    const db = await openLocalDatabase();
    const insert = await acknowledgementInsert(
      { id: "handover-1", tenant_id: TENANT, location_id: "loc-north" },
      [
        { item_key: "news2:observation:b", position: 1 },
        { item_key: "fall:observation:a", position: 0 },
      ],
      { userId: "user-carer", newId: () => "0199d000-0000-7000-8000-000000000201", sha256Base64 },
      NOW,
    );
    expect(await writeAcknowledgement(writeDb(db), insert)).toBe("written");
    // A second tap while the first waits to upload writes nothing (#36 review round 1, M1).
    const again = await acknowledgementInsert(
      { id: "handover-1", tenant_id: TENANT, location_id: "loc-north" },
      [{ item_key: "fall:observation:a", position: 0 }],
      { userId: "user-carer", newId: () => "0199d000-0000-7000-8000-000000000202", sha256Base64 },
      NOW,
    );
    expect(await writeAcknowledgement(writeDb(db), again)).toBe("already_queued");
    expect(
      all(db, "SELECT * FROM handover_acknowledgement", []).map((r) => ({ ...(r as object) })),
    ).toEqual([
      {
        id: "0199d000-0000-7000-8000-000000000201",
        tenant_id: TENANT,
        handover_id: "handover-1",
        tenant_user_id: "user-carer",
        item_keys: '["fall:observation:a","news2:observation:b"]',
        acknowledged_at: NOW.toISOString(),
        location_id: "loc-north",
        seen_token: apiToken("handover-1", ["fall:observation:a", "news2:observation:b"]),
      },
    ]);
  });
});
