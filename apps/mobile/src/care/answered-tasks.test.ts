import { beforeAll, describe, expect, it } from "vitest";
import { DISCARD_NOTE_PREFIX, KEPT_META_IDS } from "../app-state/held-work";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";
import {
  answeredMetaId,
  FORGET_ANSWER_FOR_ENTRY_SQL,
  rememberAnsweredStatements,
} from "./answered-tasks";
import * as queries from "./queries";
import { type RoundTaskRow, roundItem } from "./round-view";

/**
 * A round task is answered by one entry from this device, kept in the encrypted database's
 * bookkeeping, not in memory (#123 clinical review, M1 and its re-check; HZ-029, HZ-003).
 */

let db: SqliteDatabase;
const ADA = demoPeople[0]?.id ?? "";
const TASK = "t-answered";
const NOW = new Date("2026-10-11T10:00:00.000Z");

const save = (entryId: string, member = "me") => {
  db.prepare(
    "INSERT INTO observation (id, tenant_id, person_id, occurred_at, chart, chart_values, task_id) VALUES (?, ?, ?, ?, 'repositioning', '{}', ?)",
  ).run(entryId, DEMO_TENANT_ID, ADA, "2026-10-11T09:55:00.000Z", TASK);
  for (const s of rememberAnsweredStatements({
    tenantUserId: member,
    taskId: TASK,
    entryTable: "observation",
    entryId,
    at: NOW,
  })) {
    db.prepare(s.sql).run(...s.params);
  }
};
const state = (member = "me") =>
  all<{ answered_state: string }>(db, queries.ROUND_TASK_FOR_PERSON_SQL, [
    member,
    DEMO_TENANT_ID,
    TASK,
    ADA,
  ])[0]?.answered_state;
const round = (member = "me") => {
  const row = all<RoundTaskRow>(db, queries.ROUND_TASKS_SQL, [member, DEMO_TENANT_ID]).find(
    (r) => r.id === TASK,
  );
  if (!row) throw new Error("task not on the round");
  return roundItem(row, NOW);
};

beforeAll(async () => {
  db = await openLocalDatabase({ seedDemo: new Date("2026-10-11T09:00:00Z") });
  db.prepare(
    "INSERT INTO task (id, tenant_id, person_id, title, status, due_at, evidence_required, version) VALUES (?, ?, ?, 'Reposition', 'open', ?, 1, 1)",
  ).run(TASK, DEMO_TENANT_ID, ADA, "2026-10-11T10:30:00.000Z");
});

describe("hazard HZ-029 a round task is answered by one entry from this device (#123 clinical review, M1)", () => {
  it("is not answered until an entry for it is saved here", () => {
    expect(state()).toBe("none");
    expect(round().action).toBe("evidence");
  });

  it("waits to upload, then stays answered once the synced copy drops the task", () => {
    save("e-1");
    expect(state()).toBe("answered");
    expect(round().notices).toContain(
      "Evidence recorded, waiting to upload. Do not record it again.",
    );
    // A sync replaces the entry with Harbour's copy, which never carries task_id.
    db.prepare("UPDATE observation SET task_id = NULL WHERE id = 'e-1'").run();
    expect(state()).toBe("answered");
    // Harbour kept it but the task is still open: said in words, nothing offered, not even Not done.
    const item = round();
    expect(item.action).toBe("none");
    expect(item.chip.label).toBe("Sent, not marked done");
    expect(item.notices[0]).toMatch(/^An entry for this task was sent to Harbour/);
  });

  it("is kept in the database, so a restart does not forget it, and is the member's own", () => {
    // Nothing in memory: the state is read back from sync_meta, as after a restart.
    expect(state()).toBe("answered");
    expect(state("someone-else")).toBe("none");
  });

  it("may be answered again once Harbour refuses that entry, and is answered again by the next", () => {
    db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, payload) VALUES ('e-1', ?, ?, 'observation', ?)",
    ).run(DEMO_TENANT_ID, ADA, JSON.stringify({ task_id: TASK }));
    expect(state()).toBe("refused");
    const refused = round();
    expect(refused.action).toBe("evidence");
    expect(refused.notices[0]).toMatch(/^An entry for this task was not accepted by Harbour/);
    save("e-2");
    expect(state()).toBe("answered");
  });

  it("is not answered once its refused entry is removed to be recorded again (#123 check, M1)", () => {
    // e-2 is answered (above); Harbour refuses it, which moves it from its table to needs
    // attention, and the carer removes it from there.
    db.prepare("DELETE FROM observation WHERE id = 'e-2'").run();
    db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, payload) VALUES ('e-2', ?, ?, 'observation', '{}')",
    ).run(DEMO_TENANT_ID, ADA);
    expect(state()).toBe("refused");
    // As removeRefused does, in one transaction.
    db.prepare(queries.DELETE_UPLOAD_ISSUE_SQL).run(DEMO_TENANT_ID, "e-2");
    db.prepare(FORGET_ANSWER_FOR_ENTRY_SQL).run("e-2");
    expect(state()).toBe("none");
    expect(round().action).toBe("evidence");
    save("e-3");
    expect(state()).toBe("answered");
  });

  it("is cleared with the rest of the bookkeeping when the session is held", () => {
    const id = answeredMetaId("me", TASK);
    expect(KEPT_META_IDS as readonly string[]).not.toContain(id);
    expect(id.startsWith(DISCARD_NOTE_PREFIX)).toBe(false);
    // The statement holdUnsentWork runs on sync_meta.
    db.prepare(
      `DELETE FROM sync_meta WHERE id NOT IN (${KEPT_META_IDS.map(() => "?").join(", ")}) AND id NOT LIKE ?`,
    ).run(...KEPT_META_IDS, `${DISCARD_NOTE_PREFIX}%`);
    expect(state()).toBe("none");
  });
});
