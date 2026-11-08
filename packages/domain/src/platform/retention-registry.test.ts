import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXPORT_TABLES } from "./export-catalogue";
import type { RetentionTrigger } from "./retention";
import {
  catalogueRetentionFor,
  columnReferences,
  type DateSource,
  entryClasses,
  factsNeeded,
  NO_PERSONAL_DATA,
  RETENTION_REGISTRY,
  RETENTION_REGISTRY_CONTEXTS,
  type RetentionTableEntry,
  registryProblems,
  retentionEntry,
  type TriggerSources,
} from "./retention-registry/index";
import {
  AS_PARENT,
  asLinked,
  byValue,
  children,
  classes,
  clearColumns,
  col,
  derived,
  entry,
  firstOf,
  latestChild,
  leavingOf,
  lookup,
  NEVER,
  NO_SUBJECT,
  ofRecord,
  PARENT,
  PERMANENT,
  parentIs,
  payPeriodEnd,
  person,
  rowClass,
  staff,
  WHILE_CURRENT,
} from "./retention-registry/registry";
import { type RetentionClassRow, resolveRule, STAFF_FILE_CLASS } from "./retention-sweep";

/*
 * The retention registry (retention sweeps plan, section 5.3) against the schedule in
 * docs/specs/retention.md, read here as the seed reads it, and against the export catalogue.
 * packages/db/src/retention-registry.test.ts checks the tables and columns against the schema.
 */
const RETENTION_MD = new URL("../../../../docs/specs/retention.md", import.meta.url);

interface ScheduleRow extends RetentionClassRow {
  readonly notes: string;
}

function schedule(): ScheduleRow[] {
  const lines = readFileSync(RETENTION_MD, "utf8").split("\n");
  const start = lines.indexOf("## Retention schedule");
  const rows: ScheduleRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 7 || cells[1] === "record_class" || cells[1]?.startsWith("---")) continue;
    rows.push({
      tenantId: null,
      recordClass: cells[1] as string,
      period: Number(cells[2]),
      unit: cells[3] as string,
      trigger: cells[4] as string,
      notes: cells[6] as string,
    });
  }
  return rows;
}

const ROWS = schedule();
const TENANT = { tenantId: "00000000-0000-4000-8000-000000000001", staffFileOption: null };
const RETIRED = ROWS.filter((r) => r.notes.startsWith("Retired")).map((r) => r.recordClass);

const byTable = new Map(RETENTION_REGISTRY.map((e) => [e.table, e]));

/** Whether the entry, its parent or its children supply a trigger fact. */
function supplies(e: RetentionTableEntry, fact: keyof TriggerSources, depth = 0): boolean {
  if (depth > 10) return false;
  const parent = e.parent ? byTable.get(e.parent.table) : undefined;
  if (e.retention.kind === "as_parent") return parent ? supplies(parent, fact, depth + 1) : false;
  const source: DateSource | undefined = e.facts[fact];
  if (!source) return false;
  const inner = source.from === "pay_period_end" ? source.of : source;
  if (inner.from === "parent") return parent ? supplies(parent, fact, depth + 1) : false;
  if (inner.from === "children") {
    const child = byTable.get(inner.table);
    return child ? supplies(child, fact, depth + 1) : false;
  }
  return true;
}

const classCases = RETENTION_REGISTRY.flatMap((e) =>
  entryClasses(e).map((recordClass) => [e.table, recordClass, e] as const),
);

describe("the retention schedule as read here", () => {
  it("has the classes the registry relies on, and retires two", () => {
    expect(ROWS.length).toBeGreaterThan(30);
    expect(RETIRED).toEqual(expect.arrayContaining(["whistleblowing", "lone_worker_check_in"]));
  });
});

describe("every registry class resolves through resolveRule", () => {
  it.each(classCases)("%s: %s", (_table, recordClass) => {
    const rule = resolveRule(recordClass, ROWS, TENANT);
    expect(rule.origin, `${recordClass} is not a row of retention.md`).toBe("global");
    expect(RETIRED).not.toContain(recordClass);
  });

  it.each(classCases)("%s supplies the trigger date of %s", (_table, recordClass, e) => {
    const rule = resolveRule(recordClass, ROWS, TENANT);
    for (const fact of factsNeeded(rule.trigger, rule.recordClass)) {
      expect(supplies(e, fact), `${e.table} needs ${fact} for ${recordClass}`).toBe(true);
    }
  });

  it("resolves the staff file class to the organisation's chosen row", () => {
    expect(resolveRule(STAFF_FILE_CLASS, ROWS, TENANT).recordClass).toBe(
      "staff_file.to_75th_birthday",
    );
    expect(
      resolveRule(STAFF_FILE_CLASS, ROWS, {
        ...TENANT,
        staffFileOption: "staff_file.after_leaving",
      }).recordClass,
    ).toBe("staff_file.after_leaving");
  });
});

describe("the registry is sound", () => {
  it("has no structural problem", () => {
    expect(registryProblems(RETENTION_REGISTRY)).toEqual([]);
  });

  it("lists no table both with an entry and as holding no personal data", () => {
    const none = new Set(NO_PERSONAL_DATA.map((t) => t.table));
    expect(RETENTION_REGISTRY.filter((e) => none.has(e.table)).map((e) => e.table)).toEqual([]);
    expect(none.size).toBe(NO_PERSONAL_DATA.length);
    for (const t of NO_PERSONAL_DATA) expect(t.reason.length).toBeGreaterThan(20);
  });

  it("gives every table the export catalogue marks personal an entry", () => {
    const personal = Object.entries(EXPORT_TABLES)
      .filter(([, d]) => d.personal)
      .map(([key]) => key.replace(/^public\./, ""));
    expect(personal.filter((t) => !byTable.has(t))).toEqual([]);
  });

  it("never lists a table the catalogue marks personal as holding no personal data", () => {
    const listed = NO_PERSONAL_DATA.filter((t) => EXPORT_TABLES[`public.${t.table}`]?.personal);
    expect(listed).toEqual([]);
  });

  it("keeps each context's entries in the catalogue's context", () => {
    for (const { context, entries } of RETENTION_REGISTRY_CONTEXTS) {
      for (const e of entries) {
        const catalogued = EXPORT_TABLES[`public.${e.table}`];
        if (catalogued) expect(catalogued.context, e.table).toBe(context);
        else expect(e.table.startsWith("auth.")).toBe(true);
      }
    }
  });

  it("clears columns only where H-1560 or an existing redaction or sweep allows", () => {
    const clearing = RETENTION_REGISTRY.filter((e) => e.method.kind === "clear_columns");
    expect(clearing.map((e) => e.table).sort()).toEqual([
      "applicant",
      "lone_worker_location",
      "pay_run",
      "rota",
      "shift",
    ]);
  });

  it("finds an entry by its table", () => {
    expect(retentionEntry("lone_worker_session")?.retention).toEqual(
      rowClass("retention_class", "lone_worker"),
    );
    expect(retentionEntry("no_such_table")).toBeUndefined();
  });
});

describe("the export catalogue agrees with the registry", () => {
  const catalogued = RETENTION_REGISTRY.filter((e) => EXPORT_TABLES[`public.${e.table}`]);

  it.each(catalogued.map((e) => [e.table, e] as const))("%s", (table, e) => {
    expect(EXPORT_TABLES[`public.${table}`]?.retention).toBe(
      catalogueRetentionFor(e, RETENTION_REGISTRY),
    );
  });

  it.each([
    ["medicine_stock_item", "medicines_stock_log"],
    ["medicine_stock_movement", "medicines_stock_log"],
    ["medicine_order", "medicines_stock_log"],
    ["medicine_disposal", "medicines_disposal_log"],
    ["medicine_temperature_reading", "temperature_log"],
    ["audit_record", "quality_audit"],
    ["audit_action", "quality_audit"],
    ["payroll_export", "payroll_export"],
    ["payroll_export_result", "payroll_export"],
    ["lone_worker_location", "operational"],
    ["outbreak_case", "by_category"],
    ["employee_case", "by_category"],
    ["letter", "by_category"],
  ])("says what retention.md says for %s (%s)", (table, value) => {
    expect(EXPORT_TABLES[`public.${table}`]?.retention).toBe(value);
  });
});

// Table-driven checks of the registry's own functions, on invented tables.
const leaf = entry("leaf", classes("care_record"), { careEnded: PARENT }, person(null), {
  parent: parentIs("root", "root_id"),
});
const root = entry("root", classes("care_record"), { careEnded: col("ended_at") }, NO_SUBJECT);

describe("registryProblems", () => {
  it.each<[string, RetentionTableEntry[], string]>([
    ["a table listed twice", [root, root], "root: listed twice"],
    ["a parent with no entry", [leaf], "leaf: parent root has no entry"],
    [
      "a parent date with no parent",
      [entry("x", classes("care_record"), { careEnded: PARENT }, NO_SUBJECT)],
      "x: follows a parent it does not name",
    ],
    [
      "a subject found through a parent that is not named",
      [entry("x", classes("care_record"), {}, staff(null))],
      "x: follows a parent it does not name",
    ],
    [
      "a pay period end of the parent's date with no parent",
      [
        entry(
          "x",
          classes("rota_and_timesheet"),
          { periodEndsAt: payPeriodEnd(PARENT) },
          NO_SUBJECT,
        ),
      ],
      "x: follows a parent it does not name",
    ],
    [
      "a subject of none naming a column",
      [entry("x", classes("care_record"), {}, { kind: "none", column: "person_id" })],
      "x: a subject of none names person_id",
    ],
    [
      "configuration that would be deleted",
      [entry("x", WHILE_CURRENT, {}, NO_SUBJECT)],
      "x: method delete does not fit while_current",
    ],
    [
      "a record never destroyed",
      [entry("x", classes("care_record"), {}, NO_SUBJECT, { method: NEVER })],
      "x: method never does not fit classes",
    ],
    [
      "a class by value with no values",
      [entry("x", byValue("kind", {}), {}, NO_SUBJECT)],
      "x: a class by value with no values",
    ],
    [
      "its own parent",
      [entry("x", classes("care_record"), {}, NO_SUBJECT, { parent: parentIs("x", "x_id") })],
      "x: is its own parent",
    ],
  ])("finds %s", (_case, entries, problem) => {
    expect(registryProblems(entries)).toContain(problem);
  });

  it("finds a parent chain that loops", () => {
    const a = entry("a", AS_PARENT, {}, NO_SUBJECT, { parent: parentIs("b", "b_id") });
    const b = entry("b", AS_PARENT, {}, NO_SUBJECT, { parent: parentIs("a", "a_id") });
    expect(registryProblems([a, b])).toEqual(
      expect.arrayContaining(["a: parent chain loops at a", "b: parent chain loops at b"]),
    );
  });

  it("accepts a sound pair", () => {
    expect(registryProblems([root, leaf])).toEqual([]);
    expect(registryProblems([entry("p", PERMANENT, {}, NO_SUBJECT, { method: NEVER })])).toEqual(
      [],
    );
  });
});

describe("columnReferences", () => {
  it.each<[string, DateSource, readonly (readonly [string, string])[]]>([
    ["a column", col("closed_at"), [["t", "closed_at"]]],
    [
      "the first of two",
      firstOf("handed_over_at", "released_at"),
      [
        ["t", "handed_over_at"],
        ["t", "released_at"],
      ],
    ],
    ["the parent", PARENT, []],
    [
      "the record named",
      ofRecord("subject_type", "subject_id"),
      [
        ["t", "subject_type"],
        ["t", "subject_id"],
      ],
    ],
    [
      "a lookup",
      lookup("vacancy", "vacancy_id", "closes_on"),
      [
        ["t", "vacancy_id"],
        ["vacancy", "closes_on"],
      ],
    ],
    [
      "the latest child",
      latestChild("controlled_drug_entry", "page_id", "occurred_at"),
      [
        ["controlled_drug_entry", "page_id"],
        ["controlled_drug_entry", "occurred_at"],
      ],
    ],
    ["the children", children("handover_item", "handover_id"), [["handover_item", "handover_id"]]],
    ["a derived date", derived("a rule", "ended_on"), [["t", "ended_on"]]],
    [
      "the person's care end",
      { from: "person_care_ended", column: "person_id" },
      [["t", "person_id"]],
    ],
    ["the leaving date", leavingOf("worker_id"), [["t", "worker_id"]]],
    ["a pay period end", payPeriodEnd(col("ends_at")), [["t", "ends_at"]]],
  ])("reads %s", (_case, source, expected) => {
    const refs = columnReferences(
      entry("t", classes("care_record"), { closedAt: source }, NO_SUBJECT),
    );
    expect(refs.map((r) => [r.table, r.column])).toEqual(expected);
  });

  it("names class columns, links, subjects, the parent key and cleared columns", () => {
    const refs = (e: RetentionTableEntry) =>
      columnReferences(e).map((r) => `${r.table}.${r.column}`);
    expect(refs(entry("t", rowClass("retention_class", "complaint"), {}, NO_SUBJECT))).toEqual([
      "t.retention_class",
    ]);
    expect(
      refs(
        entry(
          "t",
          byValue(
            "status",
            { a: ["care_record"] },
            { through: { table: "person", key: "person_id" } },
          ),
          {},
          NO_SUBJECT,
        ),
      ),
    ).toEqual(["t.person_id", "person.status"]);
    expect(refs(entry("t", byValue("case_type", { a: ["care_record"] }), {}, NO_SUBJECT))).toEqual([
      "t.case_type",
    ]);
    expect(refs(entry("t", asLinked("record_type", "record_id"), {}, NO_SUBJECT))).toEqual([
      "t.record_type",
      "t.record_id",
    ]);
    expect(
      refs(
        entry(
          "t",
          { kind: "not_retained", removedBy: "a sweep", rateKey: null, at: col("delete_after") },
          {},
          staff("worker_id"),
          {
            otherSubjects: [person("person_id")],
            parent: parentIs("p", "p_id"),
            method: clearColumns("latitude"),
          },
        ),
      ),
    ).toEqual(["t.delete_after", "t.worker_id", "t.person_id", "t.p_id", "t.latitude"]);
  });
});

describe("factsNeeded", () => {
  it.each<[RetentionTrigger, string, readonly string[]]>([
    ["care_ended", "care_record", ["careEnded"]],
    ["last_entry", "controlled_drugs_register", ["entryDates"]],
    ["record_closed", "complaint", ["closedAt"]],
    ["employment_ended_or_75th_birthday", "staff_file.after_leaving", ["employmentEndedAt"]],
    ["created", "training_record", ["createdAt"]],
    ["created", "rota_and_timesheet", ["createdAt", "periodEndsAt"]],
    ["created", "payroll_export", ["createdAt", "periodEndsAt"]],
    ["tenant_policy", "organisation_document", []],
  ])("%s (%s)", (trigger, recordClass, expected) => {
    expect(factsNeeded(trigger, recordClass)).toEqual(expected);
  });
});

describe("catalogueRetentionFor", () => {
  const notRetained = entry(
    "x",
    { kind: "not_retained", removedBy: "a sweep", rateKey: null, at: col("at") },
    {},
    NO_SUBJECT,
  );
  it.each<[string, RetentionTableEntry, string | null]>([
    ["one class", root, "care_record"],
    [
      "two classes",
      entry("x", classes("staff_file", "rota_and_timesheet"), {}, NO_SUBJECT),
      "by_category",
    ],
    [
      "a row column with one value",
      entry("x", rowClass("c", "complaint"), {}, NO_SUBJECT),
      "complaint",
    ],
    [
      "a value with a fallback",
      entry(
        "x",
        byValue("k", { a: ["care_record"] }, { otherwise: ["mar_chart"] }),
        {},
        NO_SUBJECT,
      ),
      "by_category",
    ],
    ["a child", leaf, "care_record"],
    [
      "a child with no parent entry",
      entry("x", AS_PARENT, {}, NO_SUBJECT, { parent: parentIs("gone", "g") }),
      null,
    ],
    ["a link", entry("x", asLinked("t", "i"), {}, NO_SUBJECT), "as_subject"],
    ["staged data", notRetained, "operational"],
    [
      "configuration",
      entry("x", WHILE_CURRENT, {}, NO_SUBJECT, { method: NEVER }),
      "tenant_configuration",
    ],
    ["proof", entry("x", PERMANENT, {}, NO_SUBJECT, { method: NEVER }), "permanent"],
  ])("%s", (_case, e, expected) => {
    expect(catalogueRetentionFor(e, [root, leaf])).toBe(expected);
  });

  it("lists the classes of a link's fallback and none for a child", () => {
    expect(entryClasses(entry("x", asLinked("t", "i", "care_record"), {}, NO_SUBJECT))).toEqual([
      "care_record",
    ]);
    expect(entryClasses(leaf)).toEqual(["care_record"]);
    expect(entryClasses(entry("x", AS_PARENT, {}, NO_SUBJECT))).toEqual([]);
  });
});
