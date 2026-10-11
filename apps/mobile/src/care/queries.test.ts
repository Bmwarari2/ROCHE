import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { all, openLocalDatabase, type SqliteDatabase } from "../test-support/local-db";
import { insertStatement } from "./entries";
import { recentEntries } from "./entry-view";
import { checkNote } from "./notes";
import { resuscitationFlag } from "./person-summary";
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
});
