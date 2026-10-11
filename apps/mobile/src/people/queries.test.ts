import { isValidNhsNumber } from "@harbour/ui-native/logic";
import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_TENANT_ID, demoAllergies, demoPeople, demoSeedStatements } from "../demo/demo-data";
import { toPersonView } from "./person-view";
import {
  isActiveAllergyStatus,
  PEOPLE_LIST_SQL,
  PERSON_ALLERGIES_SQL,
  PERSON_SQL,
  type PersonRow,
  peopleListParams,
  personAllergiesParams,
  personParams,
} from "./queries";

/** Just enough of node:sqlite to run the app's SQL against a real SQLite engine. */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

let db: SqliteDatabase;

beforeAll(async () => {
  const moduleName = "node:sqlite";
  const sqlite = (await import(/* @vite-ignore */ moduleName)) as SqliteModule;
  db = new sqlite.DatabaseSync(":memory:");
  // Same columns as the PowerSync views in @harbour/sync (PowerSync adds the id column).
  db.exec(`
    CREATE TABLE person (id TEXT PRIMARY KEY, tenant_id TEXT, location_id TEXT, status TEXT,
      given_name TEXT, family_name TEXT, preferred_name TEXT, date_of_birth TEXT, nhs_number TEXT,
      room_label TEXT, photo_document_id TEXT, communication_needs TEXT, allergy_status TEXT,
      updated_at TEXT, version INTEGER);
    CREATE TABLE allergy (id TEXT PRIMARY KEY, tenant_id TEXT, person_id TEXT, substance TEXT,
      reaction TEXT, severity TEXT, status TEXT, recorded_at TEXT);
    CREATE TABLE location (id TEXT PRIMARY KEY, tenant_id TEXT, name TEXT, cqc_location_id TEXT,
      nation TEXT);
    CREATE TABLE sync_meta (id TEXT PRIMARY KEY, key TEXT, value TEXT);
  `);
  for (const statement of demoSeedStatements(new Date("2026-10-09T13:00:00Z"))) {
    db.prepare(statement.sql).run(...statement.params);
  }
  // Another tenant's row must never appear, even if it somehow reached the device.
  db.prepare(
    "INSERT INTO person (id, tenant_id, given_name, family_name, allergy_status) VALUES (?, ?, ?, ?, ?)",
  ).run("other-1", "other-tenant", "Zed", "Elsewhere", "unknown");
  // An allergy with no status counts as active.
  db.prepare("INSERT INTO allergy (id, tenant_id, person_id, substance) VALUES (?, ?, ?, ?)").run(
    "a-null",
    DEMO_TENANT_ID,
    demoPeople[2]?.id,
    "Latex",
  );
});

describe("demo data", () => {
  it("uses only valid NHS numbers from the 999 test range", () => {
    for (const person of demoPeople) {
      expect(person.nhs_number.startsWith("999")).toBe(true);
      expect(isValidNhsNumber(person.nhs_number)).toBe(true);
    }
  });

  it("covers all three allergy statuses", () => {
    expect(new Set(demoPeople.map((p) => p.allergy_status))).toEqual(
      new Set(["unknown", "no_known_allergies", "has_allergies"]),
    );
    expect(demoAllergies.every((a) => demoPeople.some((p) => p.id === a.person_id))).toBe(true);
  });
});

describe("people list query", () => {
  it("returns the tenant's people sorted by family name with active allergy counts", () => {
    const rows = db
      .prepare(PEOPLE_LIST_SQL)
      .all(...peopleListParams(DEMO_TENANT_ID)) as PersonRow[];
    expect(rows.map((r) => [r.family_name, r.allergy_count])).toEqual([
      ["Example", 1],
      ["Placeholder", 1],
      ["Sample", 0],
    ]);
  });

  it("feeds the list view model", () => {
    const rows = db
      .prepare(PEOPLE_LIST_SQL)
      .all(...peopleListParams(DEMO_TENANT_ID)) as PersonRow[];
    const views = rows.map(toPersonView);
    expect(views[0]?.accessibilityLabel).toBe(
      "Ada Example. Room 1. Allergies: 1 allergy recorded. Communication needs: Large print (Large print, 16 point)",
    );
    expect(views[2]?.knownAs).toBe("Bea");
    expect(views[2]?.displayName).toBe("Bea Sample");
    expect(views[2]?.subtitle).toBe("Room 2 · Beatrice Sample");
    expect(views[2]?.accessibilityLabel).toBe("Bea Sample, full name Beatrice Sample. Room 2");
    expect(views[1]?.accessibilityLabel).toContain("Allergies: 1 allergy recorded");
  });

  it("never returns another tenant's rows", () => {
    const rows = db
      .prepare(PEOPLE_LIST_SQL)
      .all(...peopleListParams("other-tenant")) as PersonRow[];
    expect(rows.map((r) => r.id)).toEqual(["other-1"]);
  });
});

describe("person queries", () => {
  it("loads one person in the tenant", () => {
    const id = demoPeople[0]?.id ?? "";
    const rows = db.prepare(PERSON_SQL).all(...personParams(DEMO_TENANT_ID, id)) as PersonRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nhs_number).toBe("9990000018");
    expect(db.prepare(PERSON_SQL).all(...personParams("other-tenant", id))).toHaveLength(0);
  });

  it("lists only active allergies", () => {
    const id = demoPeople[0]?.id ?? "";
    const rows = db
      .prepare(PERSON_ALLERGIES_SQL)
      .all(...personAllergiesParams(DEMO_TENANT_ID, id)) as Array<{ substance: string }>;
    expect(rows.map((r) => r.substance)).toEqual(["Penicillin"]);
  });
});

describe("isActiveAllergyStatus", () => {
  it.each([
    [null, true],
    ["active", true],
    ["confirmed", true],
    ["unconfirmed", true],
    [" Resolved ", false],
    ["inactive", false],
    ["refuted", false],
    ["entered-in-error", false],
  ])("%s -> %s", (status, expected) => {
    expect(isActiveAllergyStatus(status)).toBe(expected);
  });
});
