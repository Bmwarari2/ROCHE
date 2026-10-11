/**
 * Runtime PowerSync schema for the app, built from the shared definition in `@harbour/sync`.
 *
 * Why a bridge: `@harbour/sync` currently builds `AppSchema` with `@powersync/common` 1.x, while the
 * React Native SDK that supports React Native 0.86 (`@powersync/react-native` 2.x, which bundles
 * the op-sqlite adapter) uses `@powersync/common` 2.x. The two `Schema` classes are not
 * interchangeable, so the shared schema is re-created here from its JSON form, which is the
 * version-independent contract with the PowerSync SQLite core. A test proves both serialise to the
 * same JSON. Once `@harbour/sync` moves to `@powersync/common` 2.x this becomes a pass-through.
 */
import { AppSchema as SharedSchema } from "@harbour/sync/client";
import {
  type BaseColumnType,
  column,
  IndexedColumn,
  Schema,
  Table,
  type TableOptions,
} from "@powersync/common";

type ColumnTypeName = "TEXT" | "INTEGER" | "REAL";

interface ColumnJson {
  readonly name: string;
  readonly type?: string | undefined;
}

interface IndexJson {
  readonly name: string;
  readonly columns: ReadonlyArray<{
    readonly name: string;
    readonly ascending?: boolean | undefined;
  }>;
}

interface TableJson {
  readonly name: string;
  readonly view_name: string;
  readonly local_only?: boolean | undefined;
  readonly insert_only?: boolean | undefined;
  readonly include_old?: unknown;
  readonly include_old_only_when_changed?: boolean | undefined;
  readonly include_metadata?: boolean | undefined;
  readonly ignore_empty_update?: boolean | undefined;
  readonly columns: readonly ColumnJson[];
  readonly indexes: readonly IndexJson[];
}

export interface SchemaJson {
  readonly tables: readonly TableJson[];
  readonly raw_tables?: readonly unknown[];
}

export interface SerialisableSchema {
  toJSON(): unknown;
}

export interface RuntimeSchemaOptions {
  /**
   * Make every table local-only. Used for the demo database so seeded rows never enter the upload
   * queue.
   */
  readonly forceLocalOnly?: boolean;
}

const columnTypes: Record<ColumnTypeName, BaseColumnType<string | number | null>> = {
  TEXT: column.text,
  INTEGER: column.integer,
  REAL: column.real,
};

function trackPrevious(table: TableJson): TableOptions["trackPrevious"] {
  const includeOld = table.include_old;
  if (includeOld === undefined || includeOld === false || includeOld === null) return false;
  const onlyWhenChanged = table.include_old_only_when_changed === true;
  if (Array.isArray(includeOld)) {
    return {
      columns: includeOld.filter((c): c is string => typeof c === "string"),
      onlyWhenChanged,
    };
  }
  return onlyWhenChanged ? { onlyWhenChanged } : true;
}

function toTable(json: TableJson, options: RuntimeSchemaOptions): Table {
  const columns: Record<string, BaseColumnType<string | number | null>> = {};
  for (const c of json.columns) {
    const type = (c.type ?? "TEXT").toUpperCase() as ColumnTypeName;
    const mapped = columnTypes[type];
    if (!mapped) throw new Error(`Unsupported column type ${c.type} on ${json.name}.${c.name}`);
    columns[c.name] = mapped;
  }

  const indexes: Record<string, IndexedColumn[]> = {};
  for (const index of json.indexes) {
    indexes[index.name] = index.columns.map(
      (c) => new IndexedColumn({ name: c.name, ascending: c.ascending ?? true }),
    );
  }

  const localOnly = options.forceLocalOnly === true || json.local_only === true;
  return new Table(columns, {
    indexes,
    localOnly,
    insertOnly: json.insert_only === true,
    viewName: json.view_name !== json.name ? json.view_name : undefined,
    // Local-only tables cannot track previous values or metadata.
    trackPrevious: localOnly ? false : trackPrevious(json),
    trackMetadata: localOnly ? false : json.include_metadata === true,
    ignoreEmptyUpdates: json.ignore_empty_update === true,
  });
}

/** Rebuilds a schema from its JSON form with the app's PowerSync version. */
export function toRuntimeSchema(
  source: SerialisableSchema,
  options: RuntimeSchemaOptions = {},
): Schema {
  if (source instanceof Schema && !options.forceLocalOnly) return source;
  const json = source.toJSON() as SchemaJson;
  if ((json.raw_tables?.length ?? 0) > 0) {
    throw new Error("Raw tables are not supported by the schema bridge yet");
  }
  const tables = Object.fromEntries(json.tables.map((t) => [t.name, toTable(t, options)]));
  return new Schema(tables);
}

/** The schema the synced database is opened with. */
export const AppSchema = toRuntimeSchema(SharedSchema);

/** The schema for the demo database: same tables, all local-only. */
export const DemoSchema = toRuntimeSchema(SharedSchema, { forceLocalOnly: true });

export type {
  AllergyRecord,
  LocationRecord,
  PersonRecord,
} from "@harbour/sync/client";
