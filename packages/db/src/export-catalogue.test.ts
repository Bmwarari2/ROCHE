import {
  checkExportCatalogue,
  columnTypeFromSql,
  type DatabaseTable,
  dsarSubjectMap,
  EXPORT_TABLES,
  planExport,
} from "@harbour/domain";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index";

/**
 * The export catalogue (`packages/domain/src/platform/export-catalogue.ts`) against the Drizzle
 * schema, without a database: every table and every column must be classified before it can ship,
 * so a new column (a token, a key) never reaches the free full export by default (hazards HZ-070
 * and HZ-071; platform-completions.md rule 16). The schema step adds the same check against the
 * migrated database.
 */
function drizzleTables(): DatabaseTable[] {
  return (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => value instanceof PgTable)
    .map((table) => {
      const config = getTableConfig(table);
      return {
        schema: config.schema ?? "public",
        name: config.name,
        hasTenantId: config.columns.some((c) => c.name === "tenant_id"),
        columns: config.columns.map((c) => ({
          name: c.name,
          type: columnTypeFromSql(
            c.getSQLType(),
            (c as unknown as { enumValues?: readonly string[] }).enumValues ?? null,
          ),
          nullable: !c.notNull,
        })),
      };
    });
}

describe("hazard HZ-071 the export catalogue matches the Drizzle schema", () => {
  const tables = drizzleTables();

  it("classifies every public table and column, and nothing that no longer exists", () => {
    expect(
      checkExportCatalogue(tables),
      "Classify the new table or column in packages/domain/src/platform/export-catalogue.ts",
    ).toEqual([]);
  });

  it("plans every exported column with a description, and a unit for every number", () => {
    const plan = planExport(tables);
    expect(plan.unclassified).toEqual([]);
    for (const table of plan.tables) {
      for (const column of table.columns) {
        const where = `${table.key}.${column.name}`;
        expect(column.description.length, where).toBeGreaterThan(5);
        if (column.type === "integer" || column.type === "number") {
          expect(column.unit, where).toBeTruthy();
        }
      }
    }
  });

  it("never plans a column from outside the public schema", () => {
    const plan = planExport(tables);
    expect(plan.notExported.map((n) => n.name)).toEqual(expect.arrayContaining(["auth.user"]));
    expect(plan.tables.every((t) => t.key.startsWith("public."))).toBe(true);
  });
});

/**
 * Every `uuid[]` column in the Drizzle schema, with whose ids the catalogue says it holds. A
 * subject access request finds a person, contact or member of staff only where the catalogue says
 * their id sits (`dsarSubjectMap`; platform.md, the DSAR workbench, rule 3), so a new id array
 * fails here until it declares the kind of subject it holds, or why it holds no one's.
 */
function uuidArrayColumns() {
  return (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => value instanceof PgTable)
    .flatMap((table) => {
      const config = getTableConfig(table);
      const gin = new Set(
        config.indexes
          .filter((i) => i.config.method === "gin" && i.config.columns.length === 1)
          .map((i) => (i.config.columns[0] as { name?: string }).name),
      );
      return config.columns
        .filter((c) => c.getSQLType() === "uuid[]")
        .map((c) => ({
          key: `${config.schema ?? "public"}.${config.name}`,
          column: c.name,
          ginIndexed: gin.has(c.name),
        }));
    })
    .sort((a, b) => `${a.key}.${a.column}`.localeCompare(`${b.key}.${b.column}`));
}

describe("PLAT-022 every id array is declared for subject access requests", () => {
  const columns = uuidArrayColumns();
  const searched = dsarSubjectMap(EXPORT_TABLES);
  const isSearched = (table: string, column: string) =>
    [...searched.person, ...searched.contact, ...searched.staff].some(
      (e) => e.table === table && e.column === column && e.array === true,
    );

  it("finds the id arrays to check", () => {
    expect(columns.map((c) => `${c.key}.${c.column}`)).toContain("public.incident.person_ids");
  });

  it.each(columns.map((c) => [`${c.key}.${c.column}`, c] as const))(
    "%s declares whose ids it holds, and is GIN-indexed where a DSAR searches it",
    (_, { key, column, ginIndexed }) => {
      const spec = EXPORT_TABLES[key]?.columns[column];
      const declaration = typeof spec === "object" ? spec.idArray : undefined;
      expect(
        declaration,
        `Declare idArray on ${key}.${column} in packages/domain/src/platform/export-catalogue.ts`,
      ).toBeDefined();
      if (declaration?.holds === "no_subject") {
        expect(declaration.why.length).toBeGreaterThan(10);
        return;
      }
      const table = key.replace(/^public\./, "");
      const def = EXPORT_TABLES[key];
      if (def?.treatment === "tenant_rows" && def.personal) {
        expect(isSearched(table, column), `${key}.${column} is searched`).toBe(true);
        expect(ginIndexed, `add a GIN index on ${key}.${column}`).toBe(true);
      }
    },
  );

  it("declares idArray only on uuid[] columns", () => {
    const arrays = new Set(columns.map((c) => `${c.key}.${c.column}`));
    const declared = Object.entries(EXPORT_TABLES).flatMap(([key, def]) =>
      Object.entries(def.columns)
        .filter(([, spec]) => typeof spec === "object" && spec.idArray !== undefined)
        .map(([column]) => `${key}.${column}`),
    );
    expect(declared.filter((d) => !arrays.has(d))).toEqual([]);
  });
});
