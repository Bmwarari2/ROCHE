import { beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_LOCATION_ID,
  DEMO_TENANT_ID,
  demoMe,
  demoPeople,
  demoWriteScope,
} from "../demo/demo-data";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";
import { insertStatement } from "./entries";
import { recentEntries } from "./entry-view";
import { checkNote } from "./notes";
import { resuscitationFlag } from "./person-summary";
import * as queries from "./queries";
import {
  type AdvanceCareRow,
  ALL_ADVANCE_CARE_SQL,
  ASSESSMENTS_SQL,
  byPerson,
  CARE_PLAN_SQL,
  CARE_PROFILE_SQL,
  type CarePlanRow,
  type CareProfileRow,
  DELETE_UPLOAD_ISSUE_SQL,
  MARKS_SQL,
  type MarkRow,
  NOTES_SQL,
  type NoteRow,
  OBSERVATIONS_SQL,
  type ObservationRow,
  observationParams,
  PERSON_ADVANCE_CARE_SQL,
  PERSON_CONTEXT_SQL,
  PLAN_ACTIONS_SQL,
  PLAN_SECTIONS_SQL,
  RISKS_SQL,
  type RiskRow,
  UPLOAD_ISSUES_SQL,
  type UploadIssueRow,
} from "./queries";
import { checkTaskMove } from "./round-actions";
import { type RoundTaskRow, roundItems } from "./round-view";

/**
 * Care mode SQL against a real SQLite engine with the device's tables (from the shared PowerSync
 * schema) and the invented demo records, plus rows from another tenant that must never show.
 */

const [ADA, BEA, CAL] = demoPeople.map((p) => p.id) as [string, string, string];
const OTHER = "other-tenant";
let db: SqliteDatabase;

beforeAll(async () => {
  db = await openLocalDatabase({ seedDemo: new Date("2026-10-11T09:00:00Z") });
  // Rows from another tenant for the same person id must never appear (client-side assertion).
  db.prepare(
    "INSERT INTO advance_care_record (id, tenant_id, person_id, kind, status, cpr_decision, completed_on) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("other-acr", OTHER, CAL, "dnacpr", "active", "do_not_attempt_cpr", "2026-01-01");
  db.prepare(
    "INSERT INTO care_note (id, tenant_id, person_id, occurred_at, category, body) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("other-note", OTHER, ADA, "2026-10-11T08:00:00.000Z", "other", "Not for this tenant");
});

describe("care profile and the person's context", () => {
  it("reads the prescribed IDDSI levels and the SpO2 scale", () => {
    const [ada] = all<CareProfileRow>(db, CARE_PROFILE_SQL, [DEMO_TENANT_ID, ADA]);
    expect(ada).toMatchObject({ iddsi_food_level: "5", iddsi_drink_level: "2", spo2_scale2: 0 });
    const [bea] = all<CareProfileRow>(db, CARE_PROFILE_SQL, [DEMO_TENANT_ID, BEA]);
    expect(bea?.spo2_scale2).toBe(1);
    expect(all(db, CARE_PROFILE_SQL, [DEMO_TENANT_ID, CAL])).toEqual([]);
  });

  it("reads the location for new entries", () => {
    expect(all(db, PERSON_CONTEXT_SQL, [DEMO_TENANT_ID, ADA])).toEqual([
      { location_id: "00000000-0000-4000-8000-00000000d101", status: "active" },
    ]);
  });
});

describe("hazard HZ-015 resuscitation status from the device's records", () => {
  it("gives each person a status, and Cal reads 'not recorded' despite another tenant's row", () => {
    const grouped = byPerson(all<AdvanceCareRow>(db, ALL_ADVANCE_CARE_SQL, [DEMO_TENANT_ID]));
    const label = (id: string) => resuscitationFlag(grouped.get(id) ?? [], "2026-10-11").flag.label;
    expect(label(ADA)).toBe("Resuscitation: do not attempt CPR");
    expect(label(BEA)).toBe("Resuscitation: attempt CPR");
    expect(label(CAL)).toBe("Resuscitation: not recorded");
    expect(all(db, PERSON_ADVANCE_CARE_SQL, [DEMO_TENANT_ID, CAL])).toEqual([]);
  });
});

describe("entries", () => {
  it("lists a person's notes and charts for the tenant only", () => {
    const notes = all<NoteRow>(db, NOTES_SQL, [DEMO_TENANT_ID, ADA]);
    expect(notes.map((n) => n.id)).toEqual(["00000000-0000-4000-8000-00000000db01"]);
    const fluids = all<ObservationRow>(
      db,
      OBSERVATIONS_SQL,
      observationParams(DEMO_TENANT_ID, ADA, "fluid_intake"),
    );
    expect(fluids).toHaveLength(1);
    expect(all(db, OBSERVATIONS_SQL, observationParams(DEMO_TENANT_ID, ADA, "weight"))).toEqual([]);
    expect(all(db, OBSERVATIONS_SQL, observationParams(DEMO_TENANT_ID, ADA, null))).toHaveLength(1);
  });

  it("hazard HZ-017 a note written on the device and its correction read back as one current entry", () => {
    const context = {
      tenantId: DEMO_TENANT_ID,
      personId: BEA,
      locationId: null,
      userId: null,
      newId: (() => {
        const ids = [
          "0199d000-0000-7000-8000-000000000001",
          "0199d000-0000-7000-8000-000000000002",
        ];
        return () => ids.shift() ?? "0199d000-0000-7000-8000-000000000009";
      })(),
    };
    const now = new Date("2026-10-11T12:00:00Z");
    const first = checkNote(
      {
        category: "mood",
        body: "Bright and chatty",
        tags: [],
        when: { kind: "now" },
        correction: null,
      },
      context,
      now,
    );
    if (!first.ok) throw new Error("expected a valid note");
    const second = checkNote(
      {
        category: "mood",
        body: "Bright and chatty after lunch",
        tags: [],
        when: { kind: "now" },
        correction: { supersedesId: String(first.row.id), reason: "Added the time of day" },
      },
      context,
      now,
    );
    if (!second.ok) throw new Error("expected a valid correction");
    for (const row of [first.row, second.row]) {
      const statement = insertStatement("care_note", row);
      db.prepare(statement.sql).run(...statement.params);
    }
    const rows = all<NoteRow>(db, NOTES_SQL, [DEMO_TENANT_ID, BEA]);
    expect(rows).toHaveLength(2);
    const items = recentEntries(
      rows,
      [],
      all<MarkRow>(db, MARKS_SQL, [DEMO_TENANT_ID, BEA]),
      false,
    );
    expect(items.map((i) => [i.summary, i.status])).toEqual([
      ["Bright and chatty after lunch", "queued"],
    ]);
  });
});

describe("care plan and risks (read only)", () => {
  it("reads the active plan with its sections and actions", () => {
    const [plan] = all<CarePlanRow>(db, CARE_PLAN_SQL, [DEMO_TENANT_ID, ADA]);
    expect(plan?.published_version).toBe(2);
    expect(all(db, PLAN_SECTIONS_SQL, [DEMO_TENANT_ID, plan?.id])).toHaveLength(2);
    expect(all(db, PLAN_ACTIONS_SQL, [DEMO_TENANT_ID, plan?.id])).toHaveLength(2);
    expect(all(db, CARE_PLAN_SQL, [DEMO_TENANT_ID, CAL])).toEqual([]);
  });

  it("reads active risk assessments, soonest review first, and the assessments", () => {
    const risks = all<RiskRow>(db, RISKS_SQL, [DEMO_TENANT_ID, ADA]);
    expect(risks.map((r) => r.template_key)).toEqual(["choking", "falls"]);
    expect(all(db, ASSESSMENTS_SQL, [DEMO_TENANT_ID, ADA])).toHaveLength(1);
  });
});

describe("hazard HZ-006 refused uploads on the device", () => {
  it("lists them with the person's name until someone removes them", () => {
    db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, code, message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "issue-1",
      DEMO_TENANT_ID,
      BEA,
      "care_note",
      "invalid",
      "Closed",
      "{}",
      "2026-10-11T12:00:00Z",
    );
    const rows = all<UploadIssueRow>(db, UPLOAD_ISSUES_SQL, [DEMO_TENANT_ID]);
    expect(rows.map((r) => [r.id, r.preferred_name])).toEqual([["issue-1", "Bea"]]);
    expect(all(db, UPLOAD_ISSUES_SQL, [OTHER])).toEqual([]);
    db.prepare(DELETE_UPLOAD_ISSUE_SQL).run(DEMO_TENANT_ID, "issue-1");
    expect(all(db, UPLOAD_ISSUES_SQL, [DEMO_TENANT_ID])).toEqual([]);
  });

  it("hazard HZ-006 names the person a task's move is about when it was kept without them (#37 review round 1, M3)", () => {
    const insert = db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, code, message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const move = JSON.stringify({ id: "move-1", to: "done", personId: BEA, title: "Reposition" });
    insert.run(
      "move-1",
      DEMO_TENANT_ID,
      null,
      "task",
      "held_not_restored",
      "Not restored",
      JSON.stringify({ status: "done", queued_transition: move, task_id: "task-1" }),
      "2026-10-11T12:00:00Z",
    );
    // A payload that is not JSON names no one and never stops the list.
    insert.run(
      "move-2",
      DEMO_TENANT_ID,
      null,
      "task",
      "round_change_unreadable",
      "Unreadable",
      "{not json",
      "2026-10-11T11:00:00Z",
    );
    const rows = all<UploadIssueRow>(db, UPLOAD_ISSUES_SQL, [DEMO_TENANT_ID]);
    expect(rows.map((r) => [r.id, r.person_id, r.preferred_name])).toEqual([
      ["move-1", BEA, "Bea"],
      ["move-2", null, null],
    ]);
    db.prepare(DELETE_UPLOAD_ISSUE_SQL).run(DEMO_TENANT_ID, "move-1");
    db.prepare(DELETE_UPLOAD_ISSUE_SQL).run(DEMO_TENANT_ID, "move-2");
  });

  it("hazard HZ-006 shows and removes a refusal recorded without a tenant (S7)", () => {
    db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, code, message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "issue-orphan",
      null,
      null,
      "care_note",
      "entry_incomplete",
      "Missing",
      "{}",
      "2026-10-11",
    );
    const rows = all<UploadIssueRow>(db, UPLOAD_ISSUES_SQL, [DEMO_TENANT_ID]);
    expect(rows.map((r) => r.id)).toEqual(["issue-orphan"]);
    db.prepare(DELETE_UPLOAD_ISSUE_SQL).run(DEMO_TENANT_ID, "issue-orphan");
    expect(all(db, UPLOAD_ISSUES_SQL, [DEMO_TENANT_ID])).toEqual([]);
  });

  it("hazard HZ-006 keeps a refused entry's content however old, until someone removes it (clinical review M1)", () => {
    // The server keeps no copy of a refused entry, so what was recorded stays on the device until
    // a person deals with it through the recorded removal; nothing ages it out with the window.
    db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, code, message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "old",
      DEMO_TENANT_ID,
      BEA,
      "care_note",
      "invalid",
      "Closed",
      '{"body":"x"}',
      "2026-01-01T09:00:00.000Z",
    );
    const rows = all<UploadIssueRow>(db, UPLOAD_ISSUES_SQL, [DEMO_TENANT_ID]);
    expect(rows.map((r) => [r.id, r.payload])).toEqual([["old", '{"body":"x"}']]);
    // No statement the device runs clears refused content.
    for (const [name, sql] of Object.entries(queries)) {
      if (typeof sql === "string") expect(sql, name).not.toMatch(/payload\s*=\s*NULL/i);
    }
    db.prepare("DELETE FROM upload_issue").run();
  });
});

describe("the demo round (demo mode only)", () => {
  it("seeds one task of each state the round words, each markable by the demo member", () => {
    const seeded = new Date("2026-10-11T09:00:00Z");
    const rows = all<RoundTaskRow>(db, queries.ROUND_TASKS_SQL, ["me", DEMO_TENANT_ID]);
    const items = roundItems(rows, seeded);
    expect(items.map((i) => [i.timing, i.action, i.row.from_earlier_plan])).toEqual([
      ["overdue", "mark", 0],
      ["due", "evidence", 0],
      ["later", "mark", 1],
    ]);
    const overdue = items[0]?.row;
    if (!overdue) throw new Error("no demo task");
    const check = checkTaskMove(
      overdue,
      { to: "done", reason: "" },
      {
        userId: demoMe.tenantUserId ?? null,
        scope: demoWriteScope,
        personLocationId: overdue.person_location_id,
        newId: () => "0194d000-0000-7000-8000-0000000000aa",
      },
      seeded,
    );
    expect(check.ok).toBe(true);
  });
});

describe("the round on this device (screens gate items (b) and (f))", () => {
  const task = (id: string, fields: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id,
      tenant_id: DEMO_TENANT_ID,
      person_id: ADA,
      title: "Reposition",
      status: "open",
      due_at: "2026-10-11T10:30:00.000Z",
      from_earlier_plan: 0,
      ...fields,
    };
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO task (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...Object.values(row));
  };

  it("hazard HZ-029 lists the open tasks with their person, the earlier-plan flag and the evidence waiting here", () => {
    db.prepare("DELETE FROM task").run(); // the demo round's tasks
    task("t-due", { from_earlier_plan: 1 });
    task("t-evidence", { evidence_required: 1, due_at: "2026-10-11T11:00:00.000Z" });
    task("t-done", { status: "done" });
    // A task put back by a session's end: a bare row holding only its move.
    task("t-bare", { title: null, due_at: null, status: "done", queued_transition: '{"id":"m"}' });
    task("t-other", { tenant_id: OTHER });
    db.prepare(
      "INSERT INTO observation (id, tenant_id, person_id, occurred_at, chart, chart_values, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "o-evidence",
      DEMO_TENANT_ID,
      ADA,
      "2026-10-11T10:55:00.000Z",
      "repositioning",
      "{}",
      "t-evidence",
    );
    db.prepare(
      "INSERT INTO care_note (id, tenant_id, person_id, occurred_at, category, body, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "n-evidence",
      DEMO_TENANT_ID,
      ADA,
      "2026-10-11T10:56:00.000Z",
      "health",
      "Turned.",
      "t-evidence",
    );
    const rows = all<RoundTaskRow>(db, queries.ROUND_TASKS_SQL, ["me", DEMO_TENANT_ID]);
    expect(rows.map((r) => [r.id, r.evidence_waiting, r.from_earlier_plan])).toEqual([
      ["t-bare", 0, 0],
      ["t-due", 0, 1],
      ["t-evidence", 2, 0],
    ]);
    expect(rows.find((r) => r.id === "t-due")).toMatchObject({
      given_name: demoPeople[0]?.given_name,
      person_location_id: DEMO_LOCATION_ID,
    });
    expect(all<RoundTaskRow>(db, queries.ROUND_TASKS_SQL, ["me", OTHER]).map((r) => r.id)).toEqual([
      "t-other",
    ]);
    db.prepare("DELETE FROM task").run();
    db.prepare("DELETE FROM observation WHERE id = 'o-evidence'").run();
    db.prepare("DELETE FROM care_note WHERE id = 'n-evidence'").run();
  });

  it("hazard HZ-006 counts an entry for a task Harbour refused, and never a refused move or bad JSON", () => {
    db.prepare("DELETE FROM task").run();
    task("t-refused", { evidence_required: 1 });
    const issue = db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, payload) VALUES (?, ?, ?, ?, ?)",
    );
    issue.run("i-1", DEMO_TENANT_ID, ADA, "observation", JSON.stringify({ task_id: "t-refused" }));
    issue.run("i-2", DEMO_TENANT_ID, ADA, "task", JSON.stringify({ task_id: "t-refused" }));
    issue.run("i-3", DEMO_TENANT_ID, ADA, "care_note", "not json");
    const rows = all<RoundTaskRow>(db, queries.ROUND_TASKS_SQL, ["me", DEMO_TENANT_ID]);
    expect(rows.map((r) => [r.id, r.evidence_refused])).toEqual([["t-refused", 1]]);
    db.prepare("DELETE FROM upload_issue WHERE id IN ('i-1', 'i-2', 'i-3')").run();
    db.prepare("DELETE FROM task").run();
  });

  it("hazard HZ-029 counts the entries saved here for one task (the record stops tagging after one)", () => {
    expect(
      all<{ count: number }>(db, queries.TASK_EVIDENCE_SQL, [DEMO_TENANT_ID, "t-x"])[0]?.count,
    ).toBe(0);
    db.prepare(
      "INSERT INTO care_note (id, tenant_id, person_id, occurred_at, category, body, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("n-x", DEMO_TENANT_ID, ADA, "2026-10-11T10:56:00.000Z", "health", "Drink taken.", "t-x");
    expect(
      all<{ count: number }>(db, queries.TASK_EVIDENCE_SQL, [DEMO_TENANT_ID, "t-x"])[0]?.count,
    ).toBe(1);
    expect(all<{ count: number }>(db, queries.TASK_EVIDENCE_SQL, [OTHER, "t-x"])[0]?.count).toBe(0);
    // A sync replaces the entry with the server's copy, which never carries task_id: the count
    // drops to 0, so answered-tasks.ts keeps the answer (#123 clinical review, M1).
    db.prepare("UPDATE care_note SET task_id = NULL WHERE id = 'n-x'").run();
    expect(
      all<{ count: number }>(db, queries.TASK_EVIDENCE_SQL, [DEMO_TENANT_ID, "t-x"])[0]?.count,
    ).toBe(0);
    db.prepare("DELETE FROM care_note WHERE id = 'n-x'").run();
  });
});

describe("hazard HZ-029 hazard HZ-004 a route's task is used only when this device holds it for that person, open (#123 security review, M2)", () => {
  const TASK = "t-route";
  beforeAll(() => {
    db.prepare(
      "INSERT INTO task (id, tenant_id, person_id, title, status, due_at) VALUES (?, ?, ?, ?, 'open', ?)",
    ).run(TASK, DEMO_TENANT_ID, demoPeople[0]?.id ?? "", "Reposition", "2026-10-11T10:00:00Z");
  });
  const find = (taskId: string, personId: string) =>
    all<{ id: string; title: string | null }>(db, queries.ROUND_TASK_FOR_PERSON_SQL, [
      "me",
      DEMO_TENANT_ID,
      taskId,
      personId,
    ]);

  it("finds the task for its own person, with its synced title", () => {
    expect(find(TASK, demoPeople[0]?.id ?? "")).toEqual([
      expect.objectContaining({ id: TASK, title: "Reposition", answered_state: "none" }),
    ]);
  });

  it("refuses it for another person, once closed, once marked here, or in another organisation", () => {
    expect(find(TASK, demoPeople[1]?.id ?? "")).toEqual([]);
    expect(find("no-such-task", demoPeople[0]?.id ?? "")).toEqual([]);
    expect(
      all(db, queries.ROUND_TASK_FOR_PERSON_SQL, ["me", OTHER, TASK, demoPeople[0]?.id ?? ""]),
    ).toEqual([]);
    db.prepare("UPDATE task SET queued_transition = '{}' WHERE id = ?").run(TASK);
    expect(find(TASK, demoPeople[0]?.id ?? "")).toEqual([]);
    db.prepare("UPDATE task SET queued_transition = NULL, status = 'done' WHERE id = ?").run(TASK);
    expect(find(TASK, demoPeople[0]?.id ?? "")).toEqual([]);
    db.prepare("UPDATE task SET status = 'open' WHERE id = ?").run(TASK);
  });
});
