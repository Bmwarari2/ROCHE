import {
  checkExportCatalogue,
  columnTypeFromSql,
  type DatabaseTable,
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
