import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  columnReferences,
  entryClasses,
  NO_PERSONAL_DATA,
  type NoPersonalDataTable,
  RETENTION_REGISTRY,
  type RetentionTableEntry,
  resolveRule,
  STAFF_FILE_CLASS,
} from "@harbour/domain";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index";
import { parseRates, parseRetention } from "./seed/reference-data";

/**
 * The retention registry (packages/domain/src/platform/retention-registry/; retention sweeps plan,
 * section 5.3) against the Drizzle schema, without a database. Whether a table holds personal data
 * is decided mechanically: it does unless NO_PERSONAL_DATA lists it. So a new table fails here until
 * it has an entry or is listed with a reason, and an entry fails when it names a table, a column or
 * a class that does not exist (classes from docs/specs/retention.md, read by the seed's parser).
 */

interface SchemaColumn {
  readonly nullable: boolean;
  /** Tables a foreign key on this column alone, or with tenant_id, refers to. */
  readonly refersTo: readonly string[];
}

type SchemaTables = ReadonlyMap<string, ReadonlyMap<string, SchemaColumn>>;

/** Registry names: bare in `public`, `auth.<name>` elsewhere. */
const registryName = (schemaName: string | undefined, name: string) =>
  !schemaName || schemaName === "public" ? name : `${schemaName}.${name}`;

function schemaTables(): SchemaTables {
  const tables = new Map<string, Map<string, SchemaColumn>>();
  for (const value of Object.values(schema) as unknown[]) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    const refs = new Map<string, string[]>();
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const own = ref.columns.map((c) => c.name).filter((n) => n !== "tenant_id");
      const target = getTableConfig(ref.foreignTable);
      if (own.length !== 1) continue;
      const column = own[0] as string;
      refs.set(column, [...(refs.get(column) ?? []), registryName(target.schema, target.name)]);
    }
    tables.set(
      registryName(config.schema, config.name),
      new Map(
        config.columns.map((c) => [
          c.name,
          { nullable: !c.notNull, refersTo: refs.get(c.name) ?? [] },
        ]),
      ),
    );
  }
  return tables;
}

const DOCS = fileURLToPath(new URL("../../../docs/specs/", import.meta.url));
const RETENTION_ROWS = parseRetention(readFileSync(`${DOCS}retention.md`, "utf8"));
const RATE_KEYS = new Set(parseRates(readFileSync(`${DOCS}rates.md`, "utf8")).map((r) => r.key));

/** Every way the registry can disagree with the schema and the schedule. */
function registryAgainstSchema(
  entries: readonly RetentionTableEntry[],
  none: readonly NoPersonalDataTable[],
  tables: SchemaTables,
  classes: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const named = new Set([...entries.map((e) => e.table), ...none.map((t) => t.table)]);
  for (const table of tables.keys()) {
    if (!named.has(table))
      problems.push(`${table}: holds personal data unless listed, and has no registry entry`);
  }
  for (const t of none) {
    if (!tables.has(t.table))
      problems.push(`${t.table}: listed as holding no personal data, but no such table`);
  }
  for (const e of entries) {
    if (!tables.has(e.table)) {
      problems.push(`${e.table}: registry entry for a table that does not exist`);
      continue;
    }
    for (const ref of columnReferences(e)) {
      const columns = tables.get(ref.table);
      if (!columns)
        problems.push(`${e.table}: ${ref.role} names table ${ref.table}, which does not exist`);
      else if (!columns.has(ref.column))
        problems.push(
          `${e.table}: ${ref.role} names ${ref.table}.${ref.column}, which does not exist`,
        );
    }
    if (e.method.kind === "clear_columns") {
      for (const column of e.method.columns) {
        if (tables.get(e.table)?.get(column)?.nullable === false)
          problems.push(`${e.table}: clears ${column}, which is NOT NULL`);
      }
    }
    for (const recordClass of entryClasses(e)) {
      if (recordClass !== STAFF_FILE_CLASS && !classes.has(recordClass))
        problems.push(`${e.table}: class ${recordClass} is not a row of retention.md`);
    }
    if (
      e.retention.kind === "not_retained" &&
      e.retention.rateKey &&
      !RATE_KEYS.has(e.retention.rateKey)
    )
      problems.push(`${e.table}: rate key ${e.retention.rateKey} is not in rates.md`);
    // A key that is a foreign key must refer to the table the entry says it does.
    const expect = (column: string, target: string, role: string) => {
      const refersTo = tables.get(e.table)?.get(column)?.refersTo ?? [];
      if (refersTo.length > 0 && !refersTo.includes(target))
        problems.push(
          `${e.table}: ${role} ${column} refers to ${refersTo.join(", ")}, not ${target}`,
        );
    };
    if (e.parent) expect(e.parent.column, e.parent.table, "parent key");
    for (const source of Object.values(e.facts)) {
      if (source.from === "person_care_ended" && source.column !== "id")
        expect(source.column, "person", "person key");
      if (source.from === "staff_leaving" && source.column !== "id")
        expect(source.column, source.via, "staff key");
    }
  }
  return problems;
}

const TABLES = schemaTables();
const CLASSES = new Set(RETENTION_ROWS.map((r) => r.recordClass));

describe("the retention registry matches the Drizzle schema and retention.md", () => {
  it("has an entry, or a reason it holds no personal data, for every table, and names only what exists", () => {
    expect(
      registryAgainstSchema(RETENTION_REGISTRY, NO_PERSONAL_DATA, TABLES, CLASSES),
      "Add an entry in packages/domain/src/platform/retention-registry/, or list the table in no-personal-data.ts",
    ).toEqual([]);
  });

  it("covers every table in the schema exactly once", () => {
    const named = [
      ...RETENTION_REGISTRY.map((e) => e.table),
      ...NO_PERSONAL_DATA.map((t) => t.table),
    ];
    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual([...TABLES.keys()].sort());
  });

  it("resolves every class through resolveRule to a schedule row, staff files to the chosen row", () => {
    const rows = RETENTION_ROWS.map((r) => ({ ...r, tenantId: null }));
    const tenant = { tenantId: "00000000-0000-4000-8000-000000000001", staffFileOption: null };
    for (const e of RETENTION_REGISTRY) {
      for (const recordClass of entryClasses(e)) {
        expect(resolveRule(recordClass, rows, tenant).origin, `${e.table}: ${recordClass}`).toBe(
          "global",
        );
      }
    }
    expect(CLASSES).toContain("staff_file.after_leaving");
    expect(CLASSES).toContain("staff_file.to_75th_birthday");
  });
});

describe("the check fails when the registry is wrong", () => {
  const tables: SchemaTables = new Map([
    [
      "thing",
      new Map<string, SchemaColumn>([
        ["id", { nullable: false, refersTo: [] }],
        ["person_id", { nullable: false, refersTo: ["person"] }],
        ["closed_at", { nullable: true, refersTo: [] }],
      ]),
    ],
    ["settings", new Map<string, SchemaColumn>([["id", { nullable: false, refersTo: [] }]])],
  ]);
  const good: RetentionTableEntry = {
    table: "thing",
    retention: { kind: "classes", classes: ["complaint"] },
    facts: { closedAt: { from: "column", column: "closed_at" } },
    subject: { kind: "person", column: "person_id" },
    method: { kind: "delete" },
  };
  const none: NoPersonalDataTable[] = [
    { table: "settings", reason: "configuration only, for this test" },
  ];

  it("passes a registry that matches", () => {
    expect(registryAgainstSchema([good], none, tables, CLASSES)).toEqual([]);
  });

  it.each<[string, RetentionTableEntry[], NoPersonalDataTable[], string]>([
    [
      "a table with no entry",
      [],
      none,
      "thing: holds personal data unless listed, and has no registry entry",
    ],
    [
      "an entry for a table that does not exist",
      [good, { ...good, table: "ghost" }],
      none,
      "ghost: registry entry for a table that does not exist",
    ],
    [
      "a listed table that does not exist",
      [good],
      [...none, { table: "ghost", reason: "no such table, for this test" }],
      "ghost: listed as holding no personal data, but no such table",
    ],
    [
      "a column that does not exist",
      [{ ...good, facts: { closedAt: { from: "column", column: "ended_at" } } }],
      none,
      "thing: closedAt names thing.ended_at, which does not exist",
    ],
    [
      "a column on another table that does not exist",
      [
        {
          ...good,
          facts: { closedAt: { from: "lookup", table: "nowhere", key: "person_id", column: "x" } },
        },
      ],
      none,
      "thing: closedAt names table nowhere, which does not exist",
    ],
    [
      "a class that is not in retention.md",
      [{ ...good, retention: { kind: "classes", classes: ["made_up_class"] } }],
      none,
      "thing: class made_up_class is not a row of retention.md",
    ],
    [
      "a cleared column that is NOT NULL",
      [{ ...good, method: { kind: "clear_columns", columns: ["person_id"] } }],
      none,
      "thing: clears person_id, which is NOT NULL",
    ],
    [
      "a person key that refers elsewhere",
      [
        {
          ...good,
          facts: { careEnded: { from: "staff_leaving", column: "person_id", via: "tenant_user" } },
        },
      ],
      none,
      "thing: staff key person_id refers to person, not tenant_user",
    ],
    [
      "a rate key that is not in rates.md",
      [
        {
          ...good,
          retention: {
            kind: "not_retained",
            removedBy: "a sweep",
            rateKey: "no.such_key",
            at: { from: "column", column: "closed_at" },
          },
        },
      ],
      none,
      "thing: rate key no.such_key is not in rates.md",
    ],
  ])("finds %s", (_case, entries, listed, problem) => {
    expect(registryAgainstSchema(entries, listed, tables, CLASSES)).toContain(problem);
  });
});
