/**
 * Test support: a real SQLite engine (`node:sqlite`) with one table per table in the app's
 * PowerSync schema, so the app's SQL is tested against the same column names the device has.
 * PowerSync adds the `id` column to every table, so this does too.
 */
import { AppSchema } from "@harbour/sync/client";
import { demoSeedStatements } from "../demo/demo-data";

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

export async function openLocalDatabase(
  options: { seedDemo?: Date } = {},
): Promise<SqliteDatabase> {
  // A variable module name keeps node:sqlite out of the app's type graph (React Native types only).
  const moduleName = "node:sqlite";
  const sqlite = (await import(/* @vite-ignore */ moduleName)) as SqliteModule;
  const db = new sqlite.DatabaseSync(":memory:");
  for (const table of AppSchema.tables) {
    const columns = table.columns.map((c) => `${c.name} ${c.type}`).join(", ");
    db.exec(`CREATE TABLE ${table.name} (id TEXT PRIMARY KEY, ${columns})`);
  }
  if (options.seedDemo) {
    for (const statement of demoSeedStatements(options.seedDemo)) {
      db.prepare(statement.sql).run(...statement.params);
    }
  }
  return db;
}

export function all<T>(db: SqliteDatabase, sql: string, params: readonly unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
